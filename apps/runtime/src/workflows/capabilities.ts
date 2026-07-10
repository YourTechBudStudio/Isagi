import { statSync } from 'node:fs';

import { Context, Effect, Layer } from 'effect';

import type { AgentHarness, SplitPaneDirection, SurfaceLayoutNode } from '@isagi/contracts';
import type {
  WorkflowAgentHarness,
  WorkflowAgentPromptSend,
  WorkflowConversationMessage,
  WorkflowHeadlessAgentInput,
  WorkflowHeadlessOp,
  WorkflowLogLevel,
} from '@isagi/workflow-sdk';

import { getConversationHistory as readConversationHistory } from '../agent-sessions/harness/conversation.js';
import type { AgentSessionArtifactsService } from '../agent-sessions/harness/ledger.js';
import {
  HarnessLedgerObserver,
  type HarnessLedgerObserverService,
} from '../agent-sessions/harness/observer.service.js';
import {
  AgentSessionArtifacts,
  AgentSessionService,
  type AgentSessionService as AgentSessionServiceShape,
} from '../agent-sessions/index.js';
import { diagnosticPhase } from '../diagnostics/phase.js';
import { PtyService, type PtyServiceShape } from '../pty-processes/index.js';
import { SurfaceService, type SurfaceServiceShape } from '../surfaces/index.js';
import { WorkflowEventLedger, workflowEventLedgerWarningPayload } from './event-ledger.service.js';
import { WorkflowHeadless } from './headless.js';
import { appendInternalWorkflowLogBestEffort } from './run-failure.js';
import type { WorkflowRunRow, WorkflowUiFeedback } from './types.js';
import { hasInFlightTurn } from './wait-conditions.js';

type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const harnessParity: Eq<WorkflowAgentHarness, AgentHarness> = true;
void harnessParity;

const spawnTimeoutMs = 10_000;
const metadataInitialDelayMs = 100;
const metadataMaxDelayMs = 1_000;
// Seed-prompt timing uses fixed delays rather than waiting for the TUI to quiesce.
// Animated harness TUIs (spinners, status lines) never go quiet, so a quiescence
// wait either stalled the dispatcher or burned the whole spawn timeout. Instead we
// wait for the first startup output, let the TUI settle for a fixed window, send
// the seed, then submit. The path is backstopped: waitForHarnessSessionId re-sends
// Enter and times out into a visible failed run if the harness never accepts the
// seed, so a too-early submit fails loudly instead of silently mis-seeding.
const startupPollMs = 100; // Poll interval while waiting for the first PTY output.
const startupSettleMs = 500; // Settle window once the first output appears.
const spawnSeedPromptDelayMs = 500; // Further settle after startup output, before the seed.
const promptSubmitDelayMs = 250; // Gap between the bracketed paste and the submit Enter.
const submitRetryIntervalMs = 1_500;
const submitRetryLimit = 2;

export interface WorkflowCapabilitiesService {
  readonly spawnAgentSessionForRun: (input: {
    readonly run: WorkflowRunRow;
    readonly input: {
      readonly harness: WorkflowAgentHarness;
      readonly prompt: string;
      readonly model?: string | undefined;
      readonly effort?: string | undefined;
    };
  }) => Effect.Effect<WorkflowAgentPromptSend & { readonly paneId: number }, unknown>;
  readonly sendAgentPrompt: (input: {
    readonly agentSessionId: number;
    readonly text: string;
  }) => Effect.Effect<WorkflowAgentPromptSend, unknown>;
  readonly closePaneForRun: (input: {
    readonly run: WorkflowRunRow;
    readonly paneId: number;
  }) => Effect.Effect<void, unknown>;
  readonly getConversationHistory: (
    agentSessionId: number,
  ) => Effect.Effect<readonly WorkflowConversationMessage[], unknown>;
  readonly runHeadlessAgentForRun: (input: {
    readonly run: WorkflowRunRow;
    readonly worktreePath: string;
    readonly input: WorkflowHeadlessAgentInput;
  }) => Effect.Effect<WorkflowHeadlessOp, unknown>;
  readonly appendWorkflowLog: (input: {
    readonly run: WorkflowRunRow;
    readonly level: WorkflowLogLevel;
    readonly message: string;
  }) => Effect.Effect<void>;
  readonly setWorkflowUiFeedback: (input: {
    readonly run: WorkflowRunRow;
    readonly feedback: WorkflowUiFeedback;
  }) => Effect.Effect<void>;
}

export const WorkflowCapabilities = Context.GenericTag<WorkflowCapabilitiesService>(
  'isagi/WorkflowCapabilities',
);

export const WorkflowCapabilitiesLive = Layer.effect(
  WorkflowCapabilities,
  Effect.gen(function* () {
    const agents = yield* AgentSessionService;
    const surfaces = yield* SurfaceService;
    const pty = yield* PtyService;
    const artifacts = yield* AgentSessionArtifacts;
    const observer = yield* HarnessLedgerObserver;
    const headless = yield* WorkflowHeadless;
    const eventLedger = yield* WorkflowEventLedger;

    return {
      spawnAgentSessionForRun: (input) =>
        spawnAgentSession({
          run: input.run,
          agents,
          surfaces,
          pty,
          artifacts,
          observer,
          input: input.input,
        }),
      sendAgentPrompt: (input) =>
        sendAgentPrompt({
          agents,
          pty,
          observer,
          agentSessionId: input.agentSessionId,
          text: input.text,
        }),
      closePaneForRun: (input) =>
        closePane({
          run: input.run,
          surfaces,
          paneId: input.paneId,
        }),
      getConversationHistory: (agentSessionId) =>
        Effect.gen(function* () {
          const session = yield* agents.get(agentSessionId);
          const harnessSessionId = yield* harnessSessionIdForAgentSession(
            artifacts,
            agentSessionId,
          );
          return yield* readConversationHistory({
            ...session,
            harnessSessionId,
          }).pipe(Effect.provideService(HarnessLedgerObserver, observer));
        }),
      runHeadlessAgentForRun: (input) =>
        headless.runHeadlessAgent({
          runId: input.run.id,
          worktreePath: input.worktreePath,
          prompt: input.input,
        }),
      appendWorkflowLog: (input) =>
        appendInternalWorkflowLogBestEffort(eventLedger, input.run, input.level, input.message),
      setWorkflowUiFeedback: (input) =>
        eventLedger
          .append({
            runId: input.run.id,
            rootRunId: input.run.rootRunId,
            surfaceId: input.run.surfaceId,
            event: { type: 'ui_feedback', ...normalizeUiFeedback(input.feedback) },
          })
          .pipe(
            Effect.catchAll((error) =>
              Effect.sync(() => {
                console.warn('[runtime] Workflow setUiFeedback append failed', {
                  op: 'setUiFeedback',
                  ...workflowEventLedgerWarningPayload(error),
                });
              }),
            ),
            Effect.asVoid,
          ),
    } satisfies WorkflowCapabilitiesService;
  }),
);

function normalizeUiFeedback(feedback: WorkflowUiFeedback): WorkflowUiFeedback {
  return {
    kind: feedback.kind ?? 'info',
    phase: feedback.phase,
    message: feedback.message,
  };
}

export function sendAgentPrompt(input: {
  readonly agents: AgentSessionServiceShape;
  readonly pty: PtyServiceShape;
  readonly observer: HarnessLedgerObserverService;
  readonly agentSessionId: number;
  readonly text: string;
}) {
  return Effect.gen(function* () {
    yield* waitForObserverInitialization(input.observer, input.agentSessionId);
    if (yield* isTurnInFlight(input.observer, input.agentSessionId)) {
      throw new Error(
        `Cannot send an agent prompt into session ${input.agentSessionId}: a turn is already in flight.`,
      );
    }
    const ptyProcessId = yield* input.agents.activePtyProcessId(input.agentSessionId);
    const sentAt = new Date().toISOString();
    yield* writePromptToPty({
      pty: input.pty,
      ptyProcessId,
      text: input.text,
    });
    return {
      agentSessionId: input.agentSessionId,
      sentAt,
    };
  });
}

function closePane(input: {
  readonly run: WorkflowRunRow;
  readonly surfaces: SurfaceServiceShape;
  readonly paneId: number;
}) {
  return Effect.gen(function* () {
    if (input.run.surfaceId === null) {
      throw new Error(`Workflow run ${input.run.id} cannot close a pane without a surface_id.`);
    }
    yield* input.surfaces.deleteSurfacePane({
      surfaceId: input.run.surfaceId,
      paneId: input.paneId,
    });
  });
}

function spawnAgentSession(input: {
  readonly run: WorkflowRunRow;
  readonly agents: AgentSessionServiceShape;
  readonly surfaces: SurfaceServiceShape;
  readonly pty: PtyServiceShape;
  readonly artifacts: AgentSessionArtifactsService;
  readonly observer: HarnessLedgerObserverService;
  readonly input: {
    readonly harness: WorkflowAgentHarness;
    readonly prompt: string;
    readonly model?: string | undefined;
    readonly effort?: string | undefined;
  };
}) {
  return Effect.gen(function* () {
    if (input.run.worktreeId === null) {
      throw new Error(`Workflow run ${input.run.id} cannot spawn without a worktree_id.`);
    }
    if (input.run.surfaceId === null) {
      throw new Error(`Workflow run ${input.run.id} cannot spawn without a surface_id.`);
    }
    const worktreeId = input.run.worktreeId;
    const surfaceId = input.run.surfaceId;
    // Each spawn step is wrapped as a diagnostic phase so the event-loop watchdog can
    // name whichever one is on the stack if the loop stalls — spawn is the most
    // hang-prone verb (PTY launch, startup output, harness handshake).
    const phaseContext = { workflowRunId: input.run.id, harness: input.input.harness };

    const surface = yield* diagnosticPhase(
      'workflow.spawn.get_surface',
      phaseContext,
      input.surfaces.getSurfaceDetail(surfaceId),
    );
    const split = chooseSpawnSplit(surface.layout);
    const created = yield* diagnosticPhase(
      'workflow.spawn.split_pane',
      { ...phaseContext, sourcePaneId: split.sourcePaneId, direction: split.direction },
      input.surfaces.splitPane({
        worktreeId,
        split: {
          paneId: split.sourcePaneId,
          direction: split.direction,
          newPane: { kind: 'agent_session', harness: input.input.harness },
        },
      }),
    );
    const agentSessionId = yield* diagnosticPhase(
      'workflow.spawn.resolve_agent_session',
      { ...phaseContext, paneId: created.paneId },
      agentSessionIdForCreatedPane(input.surfaces, {
        surfaceId: created.surfaceId,
        paneId: created.paneId,
      }),
    );
    const sessionContext = { ...phaseContext, agentSessionId, paneId: created.paneId };
    const ptyProcessId = yield* diagnosticPhase(
      'workflow.spawn.ensure_pty',
      sessionContext,
      input.agents
        .ensureActivePtyProcess(agentSessionId, {
          model: input.input.model,
          effort: input.input.effort,
        })
        .pipe(
          Effect.timeoutFail({
            duration: `${spawnTimeoutMs} millis`,
            onTimeout: () =>
              new Error(
                `Timed out waiting for workflow agent session ${agentSessionId} PTY to become live.`,
              ),
          }),
        ),
    );
    yield* waitForObserverInitialization(input.observer, agentSessionId);
    yield* diagnosticPhase(
      'workflow.spawn.await_startup_output',
      { ...sessionContext, ptyProcessId },
      waitForPtyStartupOutput(input.pty, ptyProcessId).pipe(
        Effect.timeoutFail({
          duration: `${spawnTimeoutMs} millis`,
          onTimeout: () =>
            new Error(
              `Timed out waiting for workflow agent session ${agentSessionId} PTY startup output.`,
            ),
        }),
      ),
    );
    // Fixed settle window before the seed prompt — see the seed-timing note above.
    yield* Effect.sleep(`${spawnSeedPromptDelayMs} millis`);
    const sentAt = new Date().toISOString();
    if (yield* isTurnInFlight(input.observer, agentSessionId)) {
      throw new Error(`Cannot seed agent session ${agentSessionId}: a turn is already in flight.`);
    }
    yield* diagnosticPhase(
      'workflow.spawn.inject_seed',
      { ...sessionContext, ptyProcessId },
      writePromptToPty({
        pty: input.pty,
        ptyProcessId,
        text: input.input.prompt,
      }),
    );
    yield* diagnosticPhase(
      'workflow.spawn.await_harness_session_id',
      { ...sessionContext, ptyProcessId },
      waitForHarnessSessionId({
        artifacts: input.artifacts,
        pty: input.pty,
        ptyProcessId,
        agentSessionId,
      }).pipe(
        Effect.timeoutFail({
          duration: `${spawnTimeoutMs} millis`,
          onTimeout: () =>
            new Error(
              `Timed out waiting for workflow agent session ${agentSessionId} harness session id.`,
            ),
        }),
      ),
    );
    return {
      agentSessionId,
      sentAt,
      paneId: created.paneId,
    };
  });
}

function harnessSessionIdForAgentSession(
  artifacts: AgentSessionArtifactsService,
  agentSessionId: number,
) {
  return artifacts.readMetadata(agentSessionId).pipe(
    Effect.flatMap((metadata) => {
      if (metadata.status === 'missing') {
        return Effect.fail(
          new Error(`Agent session ${agentSessionId} has no captured harness metadata yet.`),
        );
      }
      if (metadata.status === 'invalid') {
        return Effect.fail(
          new Error(
            `Agent session ${agentSessionId} has invalid harness metadata: ${metadata.diagnostic}`,
          ),
        );
      }
      if (!metadata.metadata.harnessSessionId) {
        return Effect.fail(
          new Error(
            `Agent session ${agentSessionId} does not have a captured harness session id yet.`,
          ),
        );
      }
      return Effect.succeed(metadata.metadata.harnessSessionId);
    }),
  );
}

function writePromptToPty(input: {
  readonly pty: PtyServiceShape;
  readonly ptyProcessId: number;
  readonly text: string;
}) {
  return Effect.gen(function* () {
    const normalized = input.text.replace(/\r\n/g, '\n');
    yield* input.pty.writeInput({
      ptyProcessId: input.ptyProcessId,
      data: `\x1b[200~${normalized}\x1b[201~`,
    });
    yield* Effect.sleep(`${promptSubmitDelayMs} millis`);
    yield* input.pty.writeInput({
      ptyProcessId: input.ptyProcessId,
      data: '\r',
    });
  });
}

export function chooseSpawnSplit(layout: SurfaceLayoutNode): {
  readonly sourcePaneId: number;
  readonly direction: SplitPaneDirection;
} {
  if (layout.kind === 'leaf') {
    return { sourcePaneId: layout.paneId, direction: 'right' };
  }
  return { sourcePaneId: lastLeafPaneId(layout), direction: 'down' };
}

function lastLeafPaneId(layout: SurfaceLayoutNode): number {
  if (layout.kind === 'leaf') return layout.paneId;
  const last = layout.children.at(-1);
  if (!last) {
    throw new Error(`Cannot choose workflow spawn split from an empty layout split.`);
  }
  return lastLeafPaneId(last);
}

function isTurnInFlight(observer: HarnessLedgerObserverService, agentSessionId: number) {
  return Effect.gen(function* () {
    const edges = yield* observer.getTurnEdges(agentSessionId);
    return hasInFlightTurn(edges);
  });
}

function waitForObserverInitialization(
  observer: HarnessLedgerObserverService,
  agentSessionId: number,
): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    if ((yield* observer.getProjection(agentSessionId)) !== undefined) return;
    yield* Effect.sleep(`${startupPollMs} millis`);
    return yield* waitForObserverInitialization(observer, agentSessionId);
  });
}

function agentSessionIdForCreatedPane(
  surfaces: SurfaceServiceShape,
  input: { readonly surfaceId: number; readonly paneId: number },
) {
  return Effect.gen(function* () {
    const detail = yield* surfaces.getSurfaceDetail(input.surfaceId);
    const pane = detail.panes.find((candidate) => candidate.id === input.paneId);
    if (!pane || !pane.session || pane.session.kind !== 'agent_session') {
      throw new Error(
        `Workflow spawn created surface ${input.surfaceId} pane ${input.paneId}, but no agent session was found.`,
      );
    }
    return pane.session.agentSession.id;
  });
}

function waitForPtyStartupOutput(
  pty: PtyServiceShape,
  ptyProcessId: number,
): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const bytes = yield* ptyOutputBytes(pty, ptyProcessId);
    if (bytes > 0) {
      yield* Effect.sleep(`${startupSettleMs} millis`);
      return;
    }
    yield* Effect.sleep(`${startupPollMs} millis`);
    return yield* waitForPtyStartupOutput(pty, ptyProcessId);
  });
}

function ptyOutputBytes(pty: PtyServiceShape, ptyProcessId: number) {
  return Effect.gen(function* () {
    const plan = yield* pty.getAttachmentPlan({ ptyProcessId });
    if (plan.session.logPath) {
      return yield* Effect.try({
        try: () => statSync(plan.session.logPath ?? '').size,
        catch: () => 0,
      });
    }
    return plan.replayBytes ?? 0;
  });
}

function waitForHarnessSessionId(
  input: {
    readonly artifacts: AgentSessionArtifactsService;
    readonly pty: PtyServiceShape;
    readonly ptyProcessId: number;
    readonly agentSessionId: number;
  },
  delayMs = metadataInitialDelayMs,
  elapsedMs = 0,
  submitRetryCount = 0,
): Effect.Effect<string, unknown, never> {
  return Effect.gen(function* () {
    const metadata = yield* input.artifacts.readMetadata(input.agentSessionId);
    if (metadata.status === 'valid' && metadata.metadata.harnessSessionId) {
      return metadata.metadata.harnessSessionId;
    }
    yield* Effect.sleep(`${delayMs} millis`);
    const nextElapsedMs = elapsedMs + delayMs;
    const shouldRetrySubmit =
      submitRetryCount < submitRetryLimit &&
      nextElapsedMs >= (submitRetryCount + 1) * submitRetryIntervalMs;
    if (shouldRetrySubmit) {
      yield* input.pty.writeInput({
        ptyProcessId: input.ptyProcessId,
        data: '\r',
      });
    }
    return yield* waitForHarnessSessionId(
      input,
      Math.min(delayMs * 2, metadataMaxDelayMs),
      nextElapsedMs,
      shouldRetrySubmit ? submitRetryCount + 1 : submitRetryCount,
    );
  });
}
