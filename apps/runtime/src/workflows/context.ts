import { statSync } from 'node:fs';

import { Effect } from 'effect';

import type { AgentHarness } from '@isagi/contracts';
import type { WorkflowAgentHarness } from '@isagi/workflow-sdk';

import { getConversationHistory } from '../agent-sessions/harness/conversation.js';
import type { AgentSessionArtifactsService } from '../agent-sessions/harness/ledger.js';
import {
  HarnessLedgerObserver,
  type HarnessLedgerObserverService,
} from '../agent-sessions/harness/observer.service.js';
import type { AgentSessionService as AgentSessionServiceShape } from '../agent-sessions/index.js';
import type { PtyService as PtyServiceShape } from '../pty-processes/pty.service.js';
import type { SurfaceService as SurfaceServiceShape } from '../surfaces/index.js';
import type { WorkflowRepositoryService } from './repository.js';
import type { WorkflowContext, WorkflowRunRow } from './types.js';

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
    spawnSession: (session) =>
      runEffect(
        spawnSession({
          repository: input.repository,
          run: input.run,
          agents: input.agents,
          surfaces: input.surfaces,
          pty: input.pty,
          artifacts: input.artifacts,
          input: session,
        }),
      ),
    inject: (agentSessionId, text) =>
      runEffect(inject({ agents: input.agents, pty: input.pty, agentSessionId, text })),
    getConversationHistory: (agentSessionId) =>
      runEffect(
        getConversationHistory(agentSessionId).pipe(
          Effect.provideService(HarnessLedgerObserver, input.observer),
        ),
      ),
    setUiFeedback: (feedback) =>
      runEffect(input.repository.setUiFeedback({ runId: input.run.id, feedback })),
  };
}

export function inject(input: {
  readonly agents: AgentSessionServiceShape;
  readonly pty: PtyServiceShape;
  readonly agentSessionId: number;
  readonly text: string;
}) {
  return Effect.gen(function* () {
    const ptyProcessId = yield* input.agents.activePtyProcessId(input.agentSessionId);
    const normalized = input.text.replace(/\r\n/g, '\n');
    yield* input.pty.writeInput({
      ptyProcessId,
      data: `\x1b[200~${normalized}\x1b[201~`,
    });
    yield* input.pty.writeInput({ ptyProcessId, data: '\r' });
  });
}

function spawnSession(input: {
  readonly repository: WorkflowRepositoryService;
  readonly run: WorkflowRunRow;
  readonly agents: AgentSessionServiceShape;
  readonly surfaces: SurfaceServiceShape;
  readonly pty: PtyServiceShape;
  readonly artifacts: AgentSessionArtifactsService;
  readonly input: {
    readonly harness: WorkflowAgentHarness;
    readonly prompt: string;
  };
}) {
  return Effect.gen(function* () {
    if (input.run.worktreeId === null) {
      throw new Error(`Workflow run ${input.run.id} cannot spawn without a worktree_id.`);
    }
    const created = yield* input.surfaces.createSurface({
      worktreeId: input.run.worktreeId,
      initialPane: { kind: 'agent_session', harness: input.input.harness },
    });
    yield* input.repository.setSurfaceId({ runId: input.run.id, surfaceId: created.surfaceId });
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
    return { agentSessionId, harnessSessionId, seededAt };
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
