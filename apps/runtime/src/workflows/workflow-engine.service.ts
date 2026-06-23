import { Cause, Context, Effect, Either, Layer, Queue } from 'effect';

import type { DatabaseError } from '../persistence/index.js';
import { WorkflowRegistry } from './registry.js';
import {
  WorkflowRepository,
  type WorkflowRepositoryService,
  type WorkflowRunErrorPayload,
} from './repository.js';
import {
  waitKind,
  WorkflowEngineError,
  type WorkflowContext,
  type WorkflowEngineServiceError,
  type WorkflowResult,
  type WorkflowRunRow,
} from './types.js';

export interface WorkflowEngineService {
  readonly startDevRun: (input: {
    readonly workflowKey: string;
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

        const ctx = workflowContext(repository, run.id);
        const state = yield* Effect.try({
          try: () => parseState(run),
          catch: (cause) => cause,
        }).pipe(Effect.either);
        if (Either.isLeft(state)) {
          yield* failRun(run, stepErrorPayload(state.left, run));
          return;
        }
        const result = yield* Effect.tryPromise({
          try: () => definition.step(ctx, state.right),
          catch: (cause) => cause,
        }).pipe(Effect.either);

        if (Either.isLeft(result)) {
          yield* failRun(run, stepErrorPayload(result.left, run));
          return;
        }

        yield* persistStepResult(repository, run, result.right);
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
          const run = yield* repository.createRun({
            workflowKey: input.workflowKey,
            state: definition.initialState,
            stateVersion: 1,
          });
          yield* poke;
          return run;
        }),
      drainOnce,
      poke,
    } satisfies WorkflowEngineService;

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

    return service;
  }),
);

function workflowContext(repository: WorkflowRepositoryService, runId: number): WorkflowContext {
  return {
    setUiFeedback: (feedback) => Effect.runPromise(repository.setUiFeedback({ runId, feedback })),
  };
}

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

function parseState(run: WorkflowRunRow) {
  try {
    return JSON.parse(run.stateJson) as unknown;
  } catch (cause) {
    throw new Error(`Workflow run ${run.id} has invalid state_json.`, { cause });
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
    context: { workflowRunId: run.id, workflowKey: run.workflowKey },
  };
}

function logDrainFailure(label: string) {
  return (cause: Cause.Cause<unknown>) =>
    Effect.sync(() => {
      console.warn(`[runtime] Workflow engine drain failed (${label})`, Cause.pretty(cause));
    });
}
