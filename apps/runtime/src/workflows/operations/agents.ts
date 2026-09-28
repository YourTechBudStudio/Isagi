import { statSync } from 'node:fs';

import { Effect } from 'effect';

import type { SplitPaneDirection, SurfaceLayoutNode } from '@isagi/contracts';

import { getConversationHistory as readConversationHistory } from '../../agent-sessions/harness/conversation.js';
import type { HarnessConversationTurn } from '../../agent-sessions/harness/definition-types.js';
import type { AgentSessionArtifactsService } from '../../agent-sessions/harness/ledger.js';
import {
  HarnessLedgerObserver,
  type HarnessLedgerObserverService,
} from '../../agent-sessions/harness/observer.service.js';
import type { AgentSessionService as AgentSessionServiceShape } from '../../agent-sessions/index.js';
import { diagnosticPhase } from '../../diagnostics/phase.js';
import type { PtyServiceShape } from '../../pty-processes/index.js';
import type { SurfaceServiceShape } from '../../surfaces/index.js';
import type { AgentPort } from '../engine/runtime.js';
import type { WorkflowAgentHarness, WorkflowConversationMessage } from '../types.js';
import { hasInFlightTurn } from '../waits/latest-turn.js';

/**
 * The agent-session side effects a node function can perform: spawn a session in a new pane, send
 * it a prompt, close a pane, read its conversation.
 *
 * Owner calls only. The operation log around them lives in `context.ts`. The timing constants are
 * load-bearing against real harness TUIs and are unchanged from the original implementation.
 */

export interface AgentDeps {
  readonly agents: AgentSessionServiceShape;
  readonly surfaces: SurfaceServiceShape;
  readonly pty: PtyServiceShape;
  readonly artifacts: AgentSessionArtifactsService;
  readonly observer: HarnessLedgerObserverService;
}

export const spawnTimeoutMs = 10_000;
const metadataInitialDelayMs = 100;
const metadataMaxDelayMs = 1_000;
// Seed-prompt timing uses fixed delays rather than waiting for the TUI to quiesce: animated harness
// TUIs never go quiet. Wait for the first startup output, let the TUI settle, send the seed, then
// submit. A too-early submit fails loudly: the harness session id never appears and the spawn times
// out.
const startupPollMs = 100;
const startupSettleMs = 500;
const spawnSeedPromptDelayMs = 500;
const promptSubmitDelayMs = 250;
const submitRetryIntervalMs = 1_500;
const submitRetryLimit = 2;

/** The live agent port: owner calls into agent sessions, surfaces, PTYs and the harness observer. */
export function makeAgentPort(deps: AgentDeps): AgentPort {
  return {
    spawn: (input) => spawnAgentSession(deps, input),
    send: (input) => sendAgentPrompt(deps, input),
    closePane: (input) => closePane(deps, input),
    harnessOf: (agentSessionId) =>
      Effect.map(deps.agents.get(agentSessionId), (session) => session.harness),
    conversation: (agentSessionId, turn) => conversationHistory(deps, agentSessionId, turn),
    turnEdges: (agentSessionId, refresh) =>
      refresh
        ? deps.observer.refreshTurnEdges(agentSessionId)
        : deps.observer.getTurnEdges(agentSessionId),
    isAlive: (agentSessionId) =>
      deps.agents.activePtyProcessId(agentSessionId).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ),
  };
}

/** Splits a new agent pane off the run's surface, starts it, and sends the seed prompt. */
export function spawnAgentSession(
  deps: AgentDeps,
  input: {
    readonly worktreeId: number;
    readonly surfaceId: number;
    readonly harness: WorkflowAgentHarness;
    readonly model?: string | undefined;
    readonly effort?: string | undefined;
    readonly prompt: string;
    /** Called once the pane and session exist, so the operation log can name them early. */
    readonly onCreated: (created: {
      readonly paneId: number;
      readonly agentSessionId: number;
    }) => Effect.Effect<void, unknown>;
  },
) {
  return Effect.gen(function* () {
    const phase = { surfaceId: input.surfaceId, harness: input.harness };
    const surface = yield* diagnosticPhase(
      'workflow.spawn.get_surface',
      phase,
      deps.surfaces.getSurfaceDetail(input.surfaceId),
    );
    const split = chooseSpawnSplit(surface.layout);
    const created = yield* diagnosticPhase(
      'workflow.spawn.split_pane',
      { ...phase, sourcePaneId: split.sourcePaneId, direction: split.direction },
      deps.surfaces.splitPane({
        worktreeId: input.worktreeId,
        split: {
          paneId: split.sourcePaneId,
          direction: split.direction,
          newPane: { kind: 'agent_session', harness: input.harness },
        },
      }),
    );
    const detail = yield* deps.surfaces.getSurfaceDetail(created.surfaceId);
    const pane = detail.panes.find((candidate) => candidate.id === created.paneId);
    if (!pane || pane.session?.kind !== 'agent_session') {
      return yield* Effect.fail(
        new Error(
          `Surface ${created.surfaceId} pane ${created.paneId} was created without an agent session.`,
        ),
      );
    }
    const agentSessionId = pane.session.agentSession.id;
    yield* input.onCreated({ paneId: created.paneId, agentSessionId });

    const session = { ...phase, agentSessionId, paneId: created.paneId };
    const ptyProcessId = yield* diagnosticPhase(
      'workflow.spawn.ensure_pty',
      session,
      deps.agents
        .ensureActivePtyProcess(agentSessionId, { model: input.model, effort: input.effort })
        .pipe(
          Effect.timeoutFail({
            duration: `${spawnTimeoutMs} millis`,
            onTimeout: () =>
              new Error(`Timed out waiting for agent session ${agentSessionId} to start.`),
          }),
        ),
    );
    yield* waitForObserverInitialization(deps.observer, agentSessionId);
    yield* diagnosticPhase(
      'workflow.spawn.await_startup_output',
      { ...session, ptyProcessId },
      waitForPtyStartupOutput(deps.pty, ptyProcessId).pipe(
        Effect.timeoutFail({
          duration: `${spawnTimeoutMs} millis`,
          onTimeout: () =>
            new Error(`Timed out waiting for agent session ${agentSessionId} startup output.`),
        }),
      ),
    );
    yield* Effect.sleep(`${spawnSeedPromptDelayMs} millis`);
    if (yield* isTurnInFlight(deps.observer, agentSessionId)) {
      return yield* Effect.fail(
        new Error(`Cannot seed agent session ${agentSessionId}: a turn is already in flight.`),
      );
    }
    // Captured immediately before the PTY write: the latest-turn rule looks for turns that started
    // at or after this instant.
    const sentAt = new Date().toISOString();
    yield* diagnosticPhase(
      'workflow.spawn.inject_seed',
      { ...session, ptyProcessId },
      writePromptToPty(deps.pty, ptyProcessId, input.prompt),
    );
    const harnessSessionId = yield* diagnosticPhase(
      'workflow.spawn.await_harness_session_id',
      { ...session, ptyProcessId },
      waitForHarnessSessionId(deps, { ptyProcessId, agentSessionId }).pipe(
        Effect.timeoutFail({
          duration: `${spawnTimeoutMs} millis`,
          onTimeout: () =>
            new Error(
              `Timed out waiting for agent session ${agentSessionId} to accept its prompt.`,
            ),
        }),
      ),
    );
    return { agentSessionId, paneId: created.paneId, sentAt, harnessSessionId };
  });
}

/** Sends a prompt into an existing session. Refused while a turn is in flight. */
export function sendAgentPrompt(
  deps: AgentDeps,
  input: { readonly agentSessionId: number; readonly prompt: string },
) {
  return Effect.gen(function* () {
    yield* waitForObserverInitialization(deps.observer, input.agentSessionId);
    if (yield* isTurnInFlight(deps.observer, input.agentSessionId)) {
      return yield* Effect.fail(
        new Error(
          `Cannot send a prompt into agent session ${input.agentSessionId}: a turn is already in flight.`,
        ),
      );
    }
    const ptyProcessId = yield* deps.agents.activePtyProcessId(input.agentSessionId);
    const sentAt = new Date().toISOString();
    yield* writePromptToPty(deps.pty, ptyProcessId, input.prompt);
    return { agentSessionId: input.agentSessionId, sentAt };
  });
}

export function closePane(
  deps: AgentDeps,
  input: { readonly surfaceId: number; readonly paneId: number },
) {
  return deps.surfaces.deleteSurfacePane(input).pipe(Effect.asVoid);
}

/** The session's conversation: its latest one, or one turn's when `turn` is given. */
export function conversationHistory(
  deps: AgentDeps,
  agentSessionId: number,
  turn?: HarnessConversationTurn,
): Effect.Effect<readonly WorkflowConversationMessage[], unknown> {
  return Effect.gen(function* () {
    const session = yield* deps.agents.get(agentSessionId);
    const harnessSessionId =
      turn?.harnessSessionId ?? (yield* harnessSessionIdOf(deps.artifacts, agentSessionId));
    return yield* readConversationHistory({ ...session, harnessSessionId }, turn).pipe(
      Effect.provideService(HarnessLedgerObserver, deps.observer),
    );
  });
}

/** The last thing the assistant said in a conversation, or null when it said nothing. */
export function lastAssistantText(history: readonly WorkflowConversationMessage[]): string | null {
  for (const message of [...history].reverse()) {
    if (message.role !== 'assistant') continue;
    const text = message.parts
      .map((part) => part.text)
      .join('\n')
      .trim();
    if (text.length > 0) return text;
  }
  return null;
}

export function chooseSpawnSplit(layout: SurfaceLayoutNode): {
  readonly sourcePaneId: number;
  readonly direction: SplitPaneDirection;
} {
  if (layout.kind === 'leaf') return { sourcePaneId: layout.paneId, direction: 'right' };
  return { sourcePaneId: lastLeafPaneId(layout), direction: 'down' };
}

function lastLeafPaneId(layout: SurfaceLayoutNode): number {
  if (layout.kind === 'leaf') return layout.paneId;
  const last = layout.children.at(-1);
  if (!last) throw new Error('Cannot choose a spawn split from an empty layout split.');
  return lastLeafPaneId(last);
}

function writePromptToPty(pty: PtyServiceShape, ptyProcessId: number, text: string) {
  return Effect.gen(function* () {
    const normalized = text.replace(/\r\n/g, '\n');
    yield* pty.writeInput({ ptyProcessId, data: `\x1b[200~${normalized}\x1b[201~` });
    yield* Effect.sleep(`${promptSubmitDelayMs} millis`);
    yield* pty.writeInput({ ptyProcessId, data: '\r' });
  });
}

function isTurnInFlight(observer: HarnessLedgerObserverService, agentSessionId: number) {
  return Effect.map(observer.getTurnEdges(agentSessionId), hasInFlightTurn);
}

function waitForObserverInitialization(
  observer: HarnessLedgerObserverService,
  agentSessionId: number,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    if ((yield* observer.getProjection(agentSessionId)) !== undefined) return;
    yield* Effect.sleep(`${startupPollMs} millis`);
    return yield* waitForObserverInitialization(observer, agentSessionId);
  });
}

function waitForPtyStartupOutput(
  pty: PtyServiceShape,
  ptyProcessId: number,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const plan = yield* pty.getAttachmentPlan({ ptyProcessId });
    const bytes = plan.session.logPath
      ? yield* Effect.try({
          try: () => statSync(plan.session.logPath ?? '').size,
          catch: () => 0,
        }).pipe(Effect.orElseSucceed(() => 0))
      : (plan.replayBytes ?? 0);
    if (bytes > 0) {
      yield* Effect.sleep(`${startupSettleMs} millis`);
      return;
    }
    yield* Effect.sleep(`${startupPollMs} millis`);
    return yield* waitForPtyStartupOutput(pty, ptyProcessId);
  });
}

function harnessSessionIdOf(artifacts: AgentSessionArtifactsService, agentSessionId: number) {
  return artifacts
    .readMetadata(agentSessionId)
    .pipe(
      Effect.flatMap((metadata) =>
        metadata.status === 'valid' && metadata.metadata.harnessSessionId
          ? Effect.succeed(metadata.metadata.harnessSessionId)
          : Effect.fail(
              new Error(`Agent session ${agentSessionId} has no captured harness session id yet.`),
            ),
      ),
    );
}

/**
 * Poll for the harness session id, re-sending the submit key within bounds. Its appearance is the
 * harness acknowledging the seed prompt.
 */
function waitForHarnessSessionId(
  deps: AgentDeps,
  input: { readonly ptyProcessId: number; readonly agentSessionId: number },
  delayMs = metadataInitialDelayMs,
  elapsedMs = 0,
  retries = 0,
): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    const metadata = yield* deps.artifacts.readMetadata(input.agentSessionId);
    if (metadata.status === 'valid' && metadata.metadata.harnessSessionId) {
      return metadata.metadata.harnessSessionId;
    }
    yield* Effect.sleep(`${delayMs} millis`);
    const elapsed = elapsedMs + delayMs;
    const retry = retries < submitRetryLimit && elapsed >= (retries + 1) * submitRetryIntervalMs;
    if (retry) yield* deps.pty.writeInput({ ptyProcessId: input.ptyProcessId, data: '\r' });
    return yield* waitForHarnessSessionId(
      deps,
      input,
      Math.min(delayMs * 2, metadataMaxDelayMs),
      elapsed,
      retry ? retries + 1 : retries,
    );
  });
}
