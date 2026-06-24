import { statSync } from 'node:fs';

import { Effect } from 'effect';

import type { AgentHarness, SplitPaneDirection, SurfaceLayoutNode } from '@isagi/contracts';
import type { WorkflowAgentHarness, WorkflowVariables } from '@isagi/workflow-sdk';

import { getConversationHistory } from '../agent-sessions/harness/conversation.js';
import type { AgentSessionArtifactsService } from '../agent-sessions/harness/ledger.js';
import {
  HarnessLedgerObserver,
  type HarnessLedgerObserverService,
} from '../agent-sessions/harness/observer.service.js';
import type { AgentSessionService as AgentSessionServiceShape } from '../agent-sessions/index.js';
import type { PtyService as PtyServiceShape } from '../pty-processes/pty.service.js';
import type { SurfaceService as SurfaceServiceShape } from '../surfaces/index.js';
import type { WorkflowHeadlessService } from './headless.js';
import type { WorkflowRepositoryService } from './repository.js';
import type { WorkflowContext, WorkflowRunRow, WorkflowUiFeedback } from './types.js';

type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const harnessParity: Eq<WorkflowAgentHarness, AgentHarness> = true;
void harnessParity;

const spawnTimeoutMs = 10_000;
const metadataInitialDelayMs = 100;
const metadataMaxDelayMs = 1_000;
const startupQuietMs = 1_000;
const startupPollMs = 100;
const submitRetryIntervalMs = 1_500;
const submitRetryLimit = 2;

export function workflowContext(input: {
  readonly repository: WorkflowRepositoryService;
  readonly run: WorkflowRunRow;
  readonly agents: AgentSessionServiceShape;
  readonly surfaces: SurfaceServiceShape;
  readonly pty: PtyServiceShape;
  readonly artifacts: AgentSessionArtifactsService;
  readonly observer: HarnessLedgerObserverService;
  readonly headless: WorkflowHeadlessService;
  readonly worktreePath: string;
  readonly startWorkflow?: (input: {
    readonly parentRun: WorkflowRunRow;
    readonly workflowKey: string;
    readonly variables: WorkflowVariables;
    readonly context?: {
      readonly surfaceId?: number | undefined;
      readonly agentSessionId?: number | null | undefined;
    };
  }) => Effect.Effect<WorkflowRunRow, unknown, never>;
}): WorkflowContext {
  // Workflow callbacks are plain async TypeScript (the engine runs the whole step
  // inside `Effect.tryPromise`), so every `ctx` verb must cross the Effect->Promise
  // boundary here. The service shapes are pre-resolved (`R = never`) and verb
  // failures still surface as a rejected Promise the engine turns into a failed run,
  // so correctness holds. The deliberate v1 tradeoff is cancellation: `runPromise`
  // starts a detached root fiber, so a long `spawnSession` poll or pending `inject`
  // is NOT interrupted when the engine scope closes on shutdown. That is acceptable
  // here — the runtime owns these PTY/session resources regardless, the gate runs at
  // concurrency 1, and a JS Promise is not interruptible by Effect anyway. Revisit if
  // verbs need to abort cleanly on shutdown (would require a non-Promise verb boundary).
  const runEffect = <A>(effect: Effect.Effect<A, unknown, never>) => Effect.runPromise(effect);

  return {
    worktreePath: input.worktreePath,
    spawnSession: (session) =>
      runEffect(
        spawnSession({
          run: input.run,
          agents: input.agents,
          surfaces: input.surfaces,
          pty: input.pty,
          artifacts: input.artifacts,
          observer: input.observer,
          input: session,
        }),
      ),
    inject: (agentSessionId, text) =>
      runEffect(
        inject({
          agents: input.agents,
          pty: input.pty,
          observer: input.observer,
          agentSessionId,
          text,
        }),
      ),
    closePane: (paneId) =>
      runEffect(
        closePane({
          run: input.run,
          surfaces: input.surfaces,
          paneId,
        }),
      ),
    getConversationHistory: (agentSessionId) =>
      runEffect(
        getConversationHistory(agentSessionId).pipe(
          Effect.provideService(HarnessLedgerObserver, input.observer),
        ),
      ),
    runHeadlessPrompt: (prompt) =>
      runEffect(
        input.headless.runHeadlessPrompt({
          runId: input.run.id,
          worktreePath: input.worktreePath,
          prompt,
        }),
      ),
    startWorkflow: (workflowKey, variables = {}, context) =>
      runEffect(
        (
          input.startWorkflow ??
          (() => Effect.die('workflow startWorkflow is not available in this context'))
        )(
          context === undefined
            ? {
                parentRun: input.run,
                workflowKey,
                variables,
              }
            : {
                parentRun: input.run,
                workflowKey,
                variables,
                context,
              },
        ),
      ).then((run) => run.id),
    setUiFeedback: (feedback) =>
      runEffect(
        input.repository.setUiFeedback({
          runId: input.run.id,
          feedback: normalizeUiFeedback(feedback),
        }),
      ),
  };
}

function normalizeUiFeedback(feedback: WorkflowUiFeedback): WorkflowUiFeedback {
  return { kind: feedback.kind ?? 'info', phase: feedback.phase, message: feedback.message };
}

export function inject(input: {
  readonly agents: AgentSessionServiceShape;
  readonly pty: PtyServiceShape;
  readonly observer: HarnessLedgerObserverService;
  readonly agentSessionId: number;
  readonly text: string;
}) {
  return Effect.gen(function* () {
    if (yield* isTurnInFlight(input.observer, input.agentSessionId)) {
      throw new Error(
        `Cannot inject into agent session ${input.agentSessionId}: a turn is already in flight.`,
      );
    }
    const ptyProcessId = yield* input.agents.activePtyProcessId(input.agentSessionId);
    const normalized = input.text.replace(/\r\n/g, '\n');
    yield* input.pty.writeInput({
      ptyProcessId,
      data: `\x1b[200~${normalized}\x1b[201~`,
    });
    yield* input.pty.writeInput({ ptyProcessId, data: '\r' });
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

function spawnSession(input: {
  readonly run: WorkflowRunRow;
  readonly agents: AgentSessionServiceShape;
  readonly surfaces: SurfaceServiceShape;
  readonly pty: PtyServiceShape;
  readonly artifacts: AgentSessionArtifactsService;
  readonly observer: HarnessLedgerObserverService;
  readonly input: {
    readonly harness: WorkflowAgentHarness;
    readonly prompt: string;
  };
}) {
  return Effect.gen(function* () {
    if (input.run.worktreeId === null) {
      throw new Error(`Workflow run ${input.run.id} cannot spawn without a worktree_id.`);
    }
    if (input.run.surfaceId === null) {
      throw new Error(`Workflow run ${input.run.id} cannot spawn without a surface_id.`);
    }
    const surface = yield* input.surfaces.getSurfaceDetail(input.run.surfaceId);
    const split = chooseSpawnSplit(surface.layout);
    const created = yield* input.surfaces.splitPane({
      worktreeId: input.run.worktreeId,
      split: {
        paneId: split.sourcePaneId,
        direction: split.direction,
        newPane: { kind: 'agent_session', harness: input.input.harness },
      },
    });
    const agentSessionId = yield* agentSessionIdForCreatedPane(input.surfaces, {
      surfaceId: created.surfaceId,
      paneId: created.paneId,
    });
    const ptyProcessId = yield* input.agents.ensureActivePtyProcess(agentSessionId).pipe(
      Effect.timeoutFail({
        duration: `${spawnTimeoutMs} millis`,
        onTimeout: () =>
          new Error(
            `Timed out waiting for workflow agent session ${agentSessionId} PTY to become live.`,
          ),
      }),
    );
    yield* waitForPtyOutputQuiescence(input.pty, ptyProcessId).pipe(
      Effect.timeoutFail({
        duration: `${spawnTimeoutMs} millis`,
        onTimeout: () =>
          new Error(
            `Timed out waiting for workflow agent session ${agentSessionId} PTY startup output to settle.`,
          ),
      }),
    );
    const seededAt = new Date().toISOString();
    yield* inject({
      agents: input.agents,
      pty: input.pty,
      agentSessionId,
      text: input.input.prompt,
      observer: input.observer,
    });
    const harnessSessionId = yield* waitForHarnessSessionId({
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
    );
    return { agentSessionId, harnessSessionId, seededAt, paneId: created.paneId };
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
    const activeByHarnessSessionId = new Set<string>();
    for (const edge of edges) {
      if (edge.type === 'turn_started') {
        activeByHarnessSessionId.add(edge.harnessSessionId);
        continue;
      }
      if (edge.type === 'turn_ended' || edge.type === 'turn_failed') {
        activeByHarnessSessionId.delete(edge.harnessSessionId);
      }
    }
    return activeByHarnessSessionId.size > 0;
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

function waitForPtyOutputQuiescence(
  pty: PtyServiceShape,
  ptyProcessId: number,
  previousBytes = 0,
  stableMs = 0,
  sawOutput = false,
): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const bytes = yield* ptyOutputBytes(pty, ptyProcessId);
    const nextSawOutput = sawOutput || bytes > 0;
    const nextStableMs = bytes === previousBytes ? stableMs + startupPollMs : 0;
    if (nextSawOutput && nextStableMs >= startupQuietMs) return;
    yield* Effect.sleep(`${startupPollMs} millis`);
    return yield* waitForPtyOutputQuiescence(pty, ptyProcessId, bytes, nextStableMs, nextSawOutput);
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
      yield* input.pty.writeInput({ ptyProcessId: input.ptyProcessId, data: '\r' });
    }
    return yield* waitForHarnessSessionId(
      input,
      Math.min(delayMs * 2, metadataMaxDelayMs),
      nextElapsedMs,
      shouldRetrySubmit ? submitRetryCount + 1 : submitRetryCount,
    );
  });
}
