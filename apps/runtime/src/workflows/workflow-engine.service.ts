import { Cause, Context, Effect, Either, Layer, Queue } from 'effect';

import { AgentSessionArtifacts, AgentSessionService } from '../agent-sessions/index.js';
import { HarnessLedgerObserver } from '../agent-sessions/index.js';
import type { HarnessLedgerObserverService } from '../agent-sessions/index.js';
import type { DatabaseError } from '../persistence/index.js';
import { StateFile } from '../persistence/index.js';
import { PtyService } from '../pty-processes/index.js';
import { InternalRuntimeEventBus } from '../runtime-events/index.js';
import { SurfaceService } from '../surfaces/index.js';
import { workflowContext } from './context.js';
import { WorkflowRegistry } from './registry.js';
import {
  WorkflowRepository,
  type WorkflowRepositoryService,
  type WorkflowRunErrorPayload,
} from './repository.js';
import { isSatisfied, startWorkflowResolver } from './resolver.js';
import {
  waitKind,
  WorkflowEngineError,
  type WorkflowEngineServiceError,
  type WorkflowResult,
  type WorkflowRunRow,
  type WorkflowWaitCondition,
} from './types.js';

export interface WorkflowEngineService {
  readonly startDevRun: (input: {
    readonly workflowKey: string;
  }) => Effect.Effect<WorkflowRunRow, WorkflowEngineServiceError>;
  readonly continueDevRun: (input: {
    readonly runId: number;
  }) => Effect.Effect<WorkflowRunRow, WorkflowEngineServiceError>;
  readonly drainOnce: Effect.Effect<WorkflowDrainSummary, DatabaseError>;
  readonly poke: Effect.Effect<void>;
}

export interface WorkflowDrainSummary {
  readonly claimed: number;
}

export const WorkflowEngine = Context.GenericTag<WorkflowEngineService>('isagi/WorkflowEngine');

export const WorkflowEngineLive = Layer.scoped(
  WorkflowEngine,
  Effect.gen(function* () {
    const repository = yield* WorkflowRepository;
    const registry = yield* WorkflowRegistry;
    const stateFile = yield* StateFile;
    const eventBus = yield* InternalRuntimeEventBus;
    const agents = yield* AgentSessionService;
    const surfaces = yield* SurfaceService;
    const pty = yield* PtyService;
    const artifacts = yield* AgentSessionArtifacts;
    const observer = yield* HarnessLedgerObserver;
    const wakeQueue = yield* Queue.sliding<void>(1);
    const owner = `workflow-engine:${process.pid}:${Date.now()}`;

    const poke = wakeQueue.offer(void 0).pipe(Effect.asVoid);

    const failRun = (run: WorkflowRunRow, error: WorkflowRunErrorPayload) =>
      repository.failRun({ runId: run.id, error });

    const runClaimedStep = (run: WorkflowRunRow) =>
      Effect.gen(function* () {
        const definition = registry.get(run.workflowKey);
        if (!definition) {
          yield* failRun(run, unknownWorkflowError(run.workflowKey, registry.knownKeys()));
          return;
        }

        const ctx = workflowContext({
          repository,
          run,
          agents,
          surfaces,
          pty,
          artifacts,
          observer,
        });
        const state = yield* Effect.try({
          try: () => parseState(run),
          catch: (cause) => cause,
        }).pipe(Effect.either);
        if (Either.isLeft(state)) {
          yield* failRun(run, stepErrorPayload(state.left, run));
          return;
        }
        const event = yield* Effect.try({
          try: () => parseResumePayload(run),
          catch: (cause) => cause,
        }).pipe(Effect.either);
        if (Either.isLeft(event)) {
          yield* failRun(run, stepErrorPayload(event.left, run));
          return;
        }
        const result = yield* Effect.tryPromise({
          try: () => definition.step(ctx, state.right, event.right),
          catch: (cause) => cause,
        }).pipe(Effect.either);

        if (Either.isLeft(result)) {
          yield* failRun(run, stepErrorPayload(result.left, run));
          return;
        }

        yield* persistStepResult(repository, run, result.right);
        // Close the suspend-commit race. A turn can finish in the window between
        // the step returning and `completeSuspend` persisting the `waiting` row.
        // The bus is edge-triggered and lossy, so a `turn_ended` published in that
        // window finds no `waiting` row in the resolver and is dropped — stranding
        // the run in `waiting` until the next restart re-pauses it for a user-gated
        // continue. The ledger is the source of truth, so re-evaluate the wait we
        // just armed against it; an already-landed terminal edge wakes the run now.
        if (result.right.type === 'suspend' && result.right.condition.kind === 'turn') {
          yield* reconcileArmedTurnWait({
            runId: run.id,
            condition: result.right.condition,
            repository,
            observer,
            poke,
          });
        }
      });

    const drainOnce = Effect.gen(function* () {
      let claimed = 0;
      while (true) {
        const readyRuns = yield* repository.listReadyRuns;
        if (readyRuns.length === 0) break;

        for (const readyRun of readyRuns) {
          const claimedRun = yield* repository.claimReadyRun({ runId: readyRun.id, owner });
          if (!claimedRun) continue;
          claimed += 1;
          yield* runClaimedStep(claimedRun);
        }
      }
      return { claimed } satisfies WorkflowDrainSummary;
    });

    const service = {
      startDevRun: (input) =>
        Effect.gen(function* () {
          const definition = registry.get(input.workflowKey);
          if (!definition) {
            const knownWorkflowKeys = registry.knownKeys();
            return yield* Effect.fail(
              new WorkflowEngineError({
                code: 'unknown_workflow_key',
                message: unknownWorkflowMessage(input.workflowKey, knownWorkflowKeys),
                workflowKey: input.workflowKey,
                knownWorkflowKeys,
              }),
            );
          }
          const state = yield* stateFile.read;
          const worktreeId = state.workspace.activeWorktreeId;
          if (worktreeId === null) {
            return yield* Effect.fail(
              new WorkflowEngineError({
                code: 'no_active_worktree',
                message: 'Cannot start a workflow dev run without an active worktree.',
              }),
            );
          }
          const run = yield* repository.createRun({
            workflowKey: input.workflowKey,
            state: definition.initialState,
            stateVersion: 1,
            worktreeId,
          });
          yield* poke;
          return run;
        }),
      continueDevRun: (input) =>
        Effect.gen(function* () {
          const run = yield* repository.findRun(input.runId);
          if (!run) {
            return yield* Effect.fail(
              new WorkflowEngineError({
                code: 'workflow_run_not_found',
                message: `Workflow run ${input.runId} was not found.`,
              }),
            );
          }
          if (run.status !== 'paused') {
            return yield* Effect.fail(
              new WorkflowEngineError({
                code: 'workflow_run_not_paused',
                message: `Workflow run ${input.runId} is ${run.status}, not paused.`,
                workflowRunId: input.runId,
              }),
            );
          }

          yield* continuePausedRun({ run, repository, artifacts, observer, poke });
          const continued = yield* repository.findRun(run.id);
          return continued ?? run;
        }),
      drainOnce,
      poke,
    } satisfies WorkflowEngineService;

    yield* repository.pauseNonTerminalRuns;
    yield* drainOnce.pipe(
      Effect.catchAllCause(logDrainFailure('startup ready-row initialization')),
    );
    yield* Effect.forkScoped(
      Effect.forever(
        wakeQueue.take.pipe(
          Effect.zipRight(drainOnce),
          Effect.catchAllCause(logDrainFailure('wake drain')),
        ),
      ),
    );
    yield* startWorkflowResolver({ repository, engine: service, eventBus });

    return service;
  }),
);

function persistStepResult(
  repository: WorkflowRepositoryService,
  run: WorkflowRunRow,
  result: WorkflowResult,
) {
  if (result.type === 'cont') {
    return repository.completeCont({ runId: run.id, state: result.state });
  }

  if (result.type === 'suspend') {
    return repository.completeSuspend({
      runId: run.id,
      state: result.state,
      waitKind: waitKind(result.condition),
      waitCondition: result.condition,
    });
  }

  if (result.type === 'done') {
    return repository.completeDone(run.id);
  }

  return repository.failRun({
    runId: run.id,
    error: {
      message: `Workflow step returned an unsupported result for run ${run.id}.`,
      context: { workflowKey: run.workflowKey },
    },
  });
}

function continuePausedRun(input: {
  readonly run: WorkflowRunRow;
  readonly repository: WorkflowRepositoryService;
  readonly artifacts: import('../agent-sessions/index.js').AgentSessionArtifactsService;
  readonly observer: import('../agent-sessions/index.js').HarnessLedgerObserverService;
  readonly poke: Effect.Effect<void>;
}) {
  if (input.run.waitKind === null) {
    return input.repository
      .readyPausedRun({ runId: input.run.id })
      .pipe(Effect.zipRight(input.poke));
  }

  if (input.run.waitKind === 'turn') {
    return continuePausedTurnRun(input);
  }

  return input.repository.failRun({
    runId: input.run.id,
    error: {
      message: `Unsupported workflow continue wait_kind '${input.run.waitKind}'.`,
      context: { workflowRunId: input.run.id, waitKind: input.run.waitKind },
    },
  });
}

function continuePausedTurnRun(input: {
  readonly run: WorkflowRunRow;
  readonly repository: WorkflowRepositoryService;
  readonly artifacts: import('../agent-sessions/index.js').AgentSessionArtifactsService;
  readonly observer: import('../agent-sessions/index.js').HarnessLedgerObserverService;
  readonly poke: Effect.Effect<void>;
}) {
  return Effect.gen(function* () {
    const condition = parseTurnWaitCondition(input.run);
    if (!condition) {
      yield* input.repository.failRun({
        runId: input.run.id,
        error: {
          message: `Workflow run ${input.run.id} has an invalid turn wait_condition.`,
          context: { workflowRunId: input.run.id },
        },
      });
      return;
    }

    const metadata = yield* input.artifacts.readMetadata(condition.agentSessionId);
    const currentHarnessSessionId =
      metadata.status === 'valid' ? metadata.metadata.harnessSessionId : null;
    if (currentHarnessSessionId !== condition.harnessSessionId) {
      yield* input.repository.failRun({
        runId: input.run.id,
        error: {
          message: `Workflow run ${input.run.id} cannot continue: harness session pin mismatch.`,
          context: {
            workflowRunId: input.run.id,
            agentSessionId: condition.agentSessionId,
            expectedHarnessSessionId: condition.harnessSessionId,
            currentHarnessSessionId,
            metadataStatus: metadata.status,
          },
        },
      });
      return;
    }

    const edges = yield* input.observer.getTurnEdges(condition.agentSessionId);
    let terminalEdge: TerminalTurnEdge | null = null;
    for (const edge of edges) {
      if (!isTerminalTurnEdge(edge) || !isSatisfied(condition, edge)) continue;
      terminalEdge = edge;
      break;
    }
    if (!terminalEdge) {
      yield* input.repository.rearmPausedTurnRun(input.run.id);
      return;
    }

    yield* input.repository.readyPausedRun({
      runId: input.run.id,
      resumePayload: resumePayload(terminalEdge),
    });
    yield* input.poke;
  });
}

// Live-path catch-up for the suspend-commit race: read the ledger (source of
// truth) and wake the run if the wait it just armed is already satisfied. Mirrors
// the resolver's edge matching rather than the continue path's pin assertion — the
// pin was set moments ago in the same process, so it cannot have drifted here, and
// `wakeWaitingRun` is guarded by `status = 'waiting'` so a concurrent resolver wake
// stays single-winner.
function reconcileArmedTurnWait(input: {
  readonly runId: number;
  readonly condition: Extract<WorkflowWaitCondition, { readonly kind: 'turn' }>;
  readonly repository: WorkflowRepositoryService;
  readonly observer: HarnessLedgerObserverService;
  readonly poke: Effect.Effect<void>;
}) {
  return Effect.gen(function* () {
    const edges = yield* input.observer.getTurnEdges(input.condition.agentSessionId);
    for (const edge of edges) {
      if (!isTerminalTurnEdge(edge) || !isSatisfied(input.condition, edge)) continue;
      const woke = yield* input.repository.wakeWaitingRun({
        runId: input.runId,
        resumePayload: resumePayload(edge),
      });
      if (woke) yield* input.poke;
      return;
    }
  });
}

type TerminalTurnEdge = {
  readonly type: 'turn_ended' | 'turn_failed';
  readonly agentSessionId: number;
  readonly harnessSessionId: string;
  readonly recordedAt: string;
  readonly reason?: string | undefined;
};

function isTerminalTurnEdge(edge: { readonly type: string }): edge is TerminalTurnEdge {
  return edge.type === 'turn_ended' || edge.type === 'turn_failed';
}

function parseTurnWaitCondition(run: WorkflowRunRow) {
  if (!run.waitCondition) return null;
  try {
    const parsed = JSON.parse(run.waitCondition) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed as { readonly kind?: unknown }).kind === 'turn'
    ) {
      return parsed as import('./types.js').WorkflowWaitCondition & { readonly kind: 'turn' };
    }
    return null;
  } catch {
    return null;
  }
}

function resumePayload(edge: {
  readonly type: 'turn_ended' | 'turn_failed';
  readonly recordedAt: string;
  readonly reason?: string | undefined;
}): import('./repository.js').WorkflowResumePayload {
  if (edge.type === 'turn_failed') {
    return {
      outcome: 'failed',
      recordedAt: edge.recordedAt,
      reason: edge.reason ?? 'unknown',
    };
  }
  return { outcome: 'ended', recordedAt: edge.recordedAt };
}

function parseState(run: WorkflowRunRow) {
  try {
    return JSON.parse(run.stateJson) as unknown;
  } catch (cause) {
    throw new Error(`Workflow run ${run.id} has invalid state_json.`, { cause });
  }
}

function parseResumePayload(run: WorkflowRunRow) {
  if (!run.resumePayload) return undefined;
  try {
    return JSON.parse(run.resumePayload) as unknown;
  } catch (cause) {
    throw new Error(`Workflow run ${run.id} has invalid resume_payload.`, { cause });
  }
}

function unknownWorkflowError(
  workflowKey: string,
  knownWorkflowKeys: readonly string[],
): WorkflowRunErrorPayload {
  return {
    message: unknownWorkflowMessage(workflowKey, knownWorkflowKeys),
    context: { workflowKey, knownWorkflowKeys },
  };
}

function unknownWorkflowMessage(workflowKey: string, knownWorkflowKeys: readonly string[]) {
  const known = knownWorkflowKeys.length > 0 ? knownWorkflowKeys.join(', ') : '(none)';
  return `Unknown workflow_key '${workflowKey}'; known: ${known}`;
}

function stepErrorPayload(cause: unknown, run: WorkflowRunRow): WorkflowRunErrorPayload {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  return {
    message: error.message,
    stack: error.stack,
    context: { workflowRunId: run.id, workflowKey: run.workflowKey, ...taggedErrorContext(cause) },
  };
}

// Preserve a failing step's tagged-error identity as queryable fields rather than
// only as text baked into `message`, so a remotely reported failed run can be
// triaged by `_tag`/`code`. Best-effort: a verb rejection arrives wrapped in an
// Effect `FiberFailure` and surfaces no tag here, but a directly thrown tagged
// error (or a future structured throw) does, and the extra fields never hurt.
function taggedErrorContext(cause: unknown): Record<string, unknown> {
  if (!cause || typeof cause !== 'object') return {};
  const context: Record<string, unknown> = {};
  const tag = (cause as { readonly _tag?: unknown })._tag;
  const code = (cause as { readonly code?: unknown }).code;
  if (typeof tag === 'string') context.errorTag = tag;
  if (typeof code === 'string') context.errorCode = code;
  return context;
}

function logDrainFailure(label: string) {
  return (cause: Cause.Cause<unknown>) =>
    Effect.sync(() => {
      console.warn(`[runtime] Workflow engine drain failed (${label})`, Cause.pretty(cause));
    });
}
