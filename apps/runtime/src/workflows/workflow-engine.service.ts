import { Cause, Context, Effect, Either, Layer, Queue } from 'effect';

import { AgentSessionArtifacts, AgentSessionService } from '../agent-sessions/index.js';
import { HarnessLedgerObserver } from '../agent-sessions/index.js';
import type { HarnessLedgerObserverService } from '../agent-sessions/index.js';
import type { DatabaseError } from '../persistence/index.js';
import { PtyService } from '../pty-processes/index.js';
import { InternalRuntimeEventBus } from '../runtime-events/index.js';
import { SurfaceService } from '../surfaces/index.js';
import type { SurfaceService as SurfaceServiceShape } from '../surfaces/index.js';
import { WorkspaceRepository } from '../workspace/index.js';
import type { WorkspaceRepositoryService } from '../workspace/index.js';
import { workflowContext } from './context.js';
import { WorkflowHeadless, type WorkflowHeadlessService } from './headless.js';
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
  type WorkflowCommandManifest,
  type WorkflowEngineServiceError,
  type WorkflowLaunchContext,
  type WorkflowResult,
  type WorkflowRunRow,
  type WorkflowVariables,
  type WorkflowWaitCondition,
} from './types.js';
import {
  validateWorkflowUserInputAnswers,
  WorkflowUserInputValidationError,
} from './user-input.js';

export interface WorkflowEngineService {
  readonly listWorkflowDescriptors: (input: {
    readonly context: WorkflowStartContextInput;
  }) => Effect.Effect<readonly WorkflowDescriptorResult[], WorkflowEngineServiceError>;
  readonly startWorkflow: (input: {
    readonly workflowKey: string;
    readonly variables: WorkflowVariables;
    readonly context: WorkflowStartContextInput;
  }) => Effect.Effect<WorkflowRunRow, WorkflowEngineServiceError>;
  readonly continueDevRun: (input: {
    readonly runId: number;
  }) => Effect.Effect<WorkflowRunRow, WorkflowEngineServiceError>;
  readonly satisfyUserContinueDevRun: (input: {
    readonly runId: number;
  }) => Effect.Effect<WorkflowHumanWaitSatisfactionResult, WorkflowEngineServiceError>;
  readonly submitUserInputDevRun: (input: {
    readonly runId: number;
    readonly answers: Record<string, unknown>;
  }) => Effect.Effect<WorkflowHumanWaitSatisfactionResult, WorkflowEngineServiceError>;
  readonly drainOnce: Effect.Effect<WorkflowDrainSummary, DatabaseError>;
  readonly poke: Effect.Effect<void>;
}

export interface WorkflowDrainSummary {
  readonly claimed: number;
}

export type WorkflowHumanWaitSatisfactionResult =
  | {
      readonly outcome: 'satisfied';
      readonly run: WorkflowRunRow;
    }
  | {
      readonly outcome: 'already_resolved';
      readonly run: WorkflowRunRow;
    };

export interface WorkflowStartContextInput {
  readonly worktreeId: number;
  readonly surfaceId: number;
  readonly paneId?: number | null | undefined;
  readonly agentSessionId?: number | null | undefined;
}

export type WorkflowDescriptorResult =
  | {
      readonly ok: true;
      readonly workflowKey: string;
      readonly manifest: WorkflowCommandManifest;
    }
  | {
      readonly ok: false;
      readonly workflowKey: string;
      readonly message: string;
    };

export const WorkflowEngine = Context.GenericTag<WorkflowEngineService>('isagi/WorkflowEngine');

export const WorkflowEngineLive = Layer.scoped(
  WorkflowEngine,
  Effect.gen(function* () {
    const repository = yield* WorkflowRepository;
    const registry = yield* WorkflowRegistry;
    const workspaceRepository = yield* WorkspaceRepository;
    const eventBus = yield* InternalRuntimeEventBus;
    const agents = yield* AgentSessionService;
    const surfaces = yield* SurfaceService;
    const pty = yield* PtyService;
    const artifacts = yield* AgentSessionArtifacts;
    const observer = yield* HarnessLedgerObserver;
    const headless = yield* WorkflowHeadless;
    const wakeQueue = yield* Queue.sliding<void>(1);
    const owner = `workflow-engine:${process.pid}:${Date.now()}`;

    const poke = wakeQueue.offer(void 0).pipe(Effect.asVoid);

    const failRun = (
      run: WorkflowRunRow,
      error: WorkflowRunErrorPayload,
      stateSnapshot: { readonly state: unknown } | { readonly stateJson: string },
    ) =>
      repository
        .failRun({ runId: run.id, error, stateSnapshot, thrown: true })
        .pipe(Effect.zipRight(publishWorkflowRunTerminal(eventBus, run.id, 'failed')));

    const startWorkflowRun = (input: {
      readonly workflowKey: string;
      readonly variables: WorkflowVariables;
      readonly context: WorkflowStartContextInput;
    }) =>
      Effect.gen(function* () {
        const definition = yield* registry.get(input.workflowKey).pipe(Effect.either);
        if (Either.isLeft(definition)) {
          return yield* Effect.fail(
            new WorkflowEngineError({
              code: 'workflow_load_failed',
              message: definition.left.message,
              workflowKey: input.workflowKey,
            }),
          );
        }
        if (!definition.right) {
          const knownWorkflowKeys = yield* registry.knownKeys.pipe(
            Effect.mapError(
              (cause) =>
                new WorkflowEngineError({
                  code: 'workflow_load_failed',
                  message: cause.message,
                  workflowKey: input.workflowKey,
                }),
            ),
          );
          return yield* Effect.fail(
            new WorkflowEngineError({
              code: 'unknown_workflow_key',
              message: unknownWorkflowMessage(input.workflowKey, knownWorkflowKeys),
              workflowKey: input.workflowKey,
              knownWorkflowKeys,
            }),
          );
        }
        const loadedDefinition = definition.right;
        const launchCtx = yield* buildLaunchContext(input.context, {
          workspaceRepository,
          surfaces,
        });
        const validated = yield* Effect.tryPromise({
          try: async () => loadedDefinition.validate(launchCtx, input.variables),
          catch: (cause) => cause,
        }).pipe(Effect.either);
        if (Either.isLeft(validated)) {
          return yield* Effect.fail(
            new WorkflowEngineError({
              code: 'validation_failed',
              message: errorMessage(validated.left),
              workflowKey: input.workflowKey,
            }),
          );
        }
        const initialState = yield* Effect.tryPromise({
          try: async () => loadedDefinition.init(launchCtx, input.variables),
          catch: (cause) => cause,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new WorkflowEngineError({
                code: 'validation_failed',
                message: errorMessage(cause),
                workflowKey: input.workflowKey,
              }),
          ),
        );
        const run = yield* repository.createRun({
          workflowKey: input.workflowKey,
          state: initialState,
          stateVersion: 1,
          worktreeId: launchCtx.worktreeId,
          surfaceId: launchCtx.surfaceId,
        });
        yield* poke;
        return run;
      });

    const runClaimedStep = (run: WorkflowRunRow) =>
      Effect.gen(function* () {
        const definition = yield* registry.get(run.workflowKey).pipe(Effect.either);
        if (Either.isLeft(definition)) {
          yield* failRun(run, stepErrorPayload(definition.left, run), { stateJson: run.stateJson });
          return;
        }
        if (!definition.right) {
          const knownWorkflowKeys = yield* registry.knownKeys.pipe(
            Effect.catchAll(() => Effect.succeed([])),
          );
          yield* failRun(run, unknownWorkflowError(run.workflowKey, knownWorkflowKeys), {
            stateJson: run.stateJson,
          });
          return;
        }
        const loadedDefinition = definition.right;
        const worktreePath = yield* worktreePathForRun(run, workspaceRepository).pipe(
          Effect.either,
        );
        if (Either.isLeft(worktreePath)) {
          yield* failRun(run, stepErrorPayload(worktreePath.left, run), {
            stateJson: run.stateJson,
          });
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
          headless,
          worktreePath: worktreePath.right,
          startWorkflow: ({ parentRun, workflowKey, variables, context }) =>
            Effect.gen(function* () {
              if (parentRun.worktreeId === null) {
                throw new Error(
                  `Workflow run ${parentRun.id} cannot start a workflow without a worktree_id.`,
                );
              }
              const surfaceId = context?.surfaceId ?? parentRun.surfaceId;
              if (surfaceId === null) {
                throw new Error(
                  `Workflow run ${parentRun.id} cannot start a workflow without a surface_id.`,
                );
              }
              return yield* startWorkflowRun({
                workflowKey,
                variables,
                context: {
                  worktreeId: parentRun.worktreeId,
                  surfaceId,
                  agentSessionId: context?.agentSessionId ?? null,
                },
              });
            }),
        });
        const state = yield* Effect.try({
          try: () => parseState(run),
          catch: (cause) => cause,
        }).pipe(Effect.either);
        if (Either.isLeft(state)) {
          yield* failRun(run, stepErrorPayload(state.left, run), { stateJson: run.stateJson });
          return;
        }
        const event = yield* Effect.try({
          try: () => parseResumePayload(run),
          catch: (cause) => cause,
        }).pipe(Effect.either);
        if (Either.isLeft(event)) {
          yield* failRun(run, stepErrorPayload(event.left, run), { state: state.right });
          return;
        }
        const result = yield* Effect.tryPromise({
          try: async () => loadedDefinition.step(ctx, state.right, event.right),
          catch: (cause) => cause,
        }).pipe(Effect.either);

        if (Either.isLeft(result)) {
          yield* failRun(run, stepErrorPayload(result.left, run), { state: state.right });
          return;
        }

        yield* persistStepResult({ repository, eventBus }, run, state.right, result.right);
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
        if (result.right.type === 'suspend' && result.right.condition.kind === 'headless') {
          yield* reconcileArmedHeadlessWait({
            runId: run.id,
            condition: result.right.condition,
            repository,
            headless,
            poke,
          });
        }
        if (result.right.type === 'suspend' && result.right.condition.kind === 'workflow') {
          yield* reconcileArmedWorkflowWait({
            run,
            condition: result.right.condition,
            repository,
            eventBus,
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
      listWorkflowDescriptors: (input) =>
        Effect.gen(function* () {
          const launchCtx = yield* buildLaunchContext(input.context, {
            workspaceRepository,
            surfaces,
          });
          const keys = yield* registry.knownKeys.pipe(
            Effect.mapError(
              (cause) =>
                new WorkflowEngineError({
                  code: 'workflow_load_failed',
                  message: cause.message,
                }),
            ),
          );
          const results: WorkflowDescriptorResult[] = [];
          for (const workflowKey of keys) {
            const definition = yield* registry.get(workflowKey).pipe(Effect.either);
            if (Either.isLeft(definition)) {
              results.push({
                ok: false,
                workflowKey,
                message: definition.left.message,
              });
              continue;
            }
            if (!definition.right) {
              results.push({
                ok: false,
                workflowKey,
                message: unknownWorkflowMessage(workflowKey, keys),
              });
              continue;
            }
            const loadedDefinition = definition.right;
            const manifest = yield* Effect.tryPromise({
              try: async () => loadedDefinition.command(launchCtx),
              catch: (cause) => cause,
            }).pipe(Effect.either);
            if (Either.isLeft(manifest)) {
              results.push({
                ok: false,
                workflowKey,
                message: errorMessage(manifest.left),
              });
              continue;
            }
            results.push({ ok: true, workflowKey, manifest: manifest.right });
          }
          return results;
        }),
      startWorkflow: (input) => startWorkflowRun(input),
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

          yield* continuePausedRun({
            run,
            repository,
            artifacts,
            observer,
            headless,
            workspaceRepository,
            eventBus,
            poke,
          });
          const continued = yield* repository.findRun(run.id);
          return continued ?? run;
        }),
      satisfyUserContinueDevRun: (input) =>
        Effect.gen(function* () {
          const run = yield* findRunOrFail(repository, input.runId);
          if (run.status !== 'waiting') return { outcome: 'already_resolved', run } as const;
          if (run.waitKind !== 'user_continue') {
            return yield* Effect.fail(
              new WorkflowEngineError({
                code: 'workflow_wait_not_satisfiable',
                message: `Workflow run ${run.id} is waiting on '${run.waitKind ?? 'none'}', not 'user_continue'.`,
                workflowRunId: run.id,
              }),
            );
          }
          const woke = yield* repository.wakeWaitingRun({
            runId: run.id,
            resumePayload: { kind: 'user_continue' },
          });
          if (!woke) {
            const current = yield* repository.findRun(run.id);
            return { outcome: 'already_resolved', run: current ?? run } as const;
          }
          yield* poke;
          const current = yield* repository.findRun(run.id);
          return { outcome: 'satisfied', run: current ?? run } as const;
        }),
      submitUserInputDevRun: (input) =>
        Effect.gen(function* () {
          const run = yield* findRunOrFail(repository, input.runId);
          if (run.status !== 'waiting') return { outcome: 'already_resolved', run } as const;
          if (run.waitKind !== 'user_input') {
            return yield* Effect.fail(
              new WorkflowEngineError({
                code: 'workflow_wait_not_satisfiable',
                message: `Workflow run ${run.id} is waiting on '${run.waitKind ?? 'none'}', not 'user_input'.`,
                workflowRunId: run.id,
              }),
            );
          }
          const condition = parseUserInputWaitCondition(run);
          if (!condition) {
            return yield* Effect.fail(
              new WorkflowEngineError({
                code: 'workflow_user_input_invalid',
                message: `Workflow run ${run.id} has an invalid user_input wait_condition.`,
                workflowRunId: run.id,
              }),
            );
          }
          const answers = yield* Effect.try({
            try: () =>
              validateWorkflowUserInputAnswers({
                questions: condition.questions,
                answers: input.answers,
              }),
            catch: (cause) => userInputError(cause, run.id),
          });
          const woke = yield* repository.wakeWaitingRun({
            runId: run.id,
            resumePayload: { kind: 'user_input', answers },
          });
          if (!woke) {
            const current = yield* repository.findRun(run.id);
            return { outcome: 'already_resolved', run: current ?? run } as const;
          }
          yield* poke;
          const current = yield* repository.findRun(run.id);
          return { outcome: 'satisfied', run: current ?? run } as const;
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
    yield* startWorkflowResolver({ repository, engine: service, eventBus, headless });

    return service;
  }),
);

function buildLaunchContext(
  context: WorkflowStartContextInput,
  services: {
    readonly workspaceRepository: WorkspaceRepositoryService;
    readonly surfaces: SurfaceServiceShape;
  },
): Effect.Effect<WorkflowLaunchContext, WorkflowEngineServiceError> {
  return Effect.gen(function* () {
    const worktree = yield* services.workspaceRepository.findWorktree(context.worktreeId);
    if (!worktree) {
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'worktree_not_found',
          message: `Worktree ${context.worktreeId} was not found.`,
          worktreeId: context.worktreeId,
        }),
      );
    }

    const surface = yield* services.surfaces.getSurfaceDetail(context.surfaceId).pipe(
      Effect.mapError(
        (cause) =>
          new WorkflowEngineError({
            code: 'surface_not_found',
            message: errorMessage(cause),
            worktreeId: context.worktreeId,
            surfaceId: context.surfaceId,
          }),
      ),
    );
    if (surface.worktreeId !== worktree.id) {
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'surface_worktree_mismatch',
          message: `Surface ${surface.id} belongs to worktree ${surface.worktreeId}, not worktree ${worktree.id}.`,
          worktreeId: worktree.id,
          surfaceId: surface.id,
        }),
      );
    }

    if (context.agentSessionId !== undefined && context.agentSessionId !== null) {
      const agentPane = surface.panes.find(
        (candidate) =>
          candidate.session?.kind === 'agent_session' &&
          candidate.session.agentSession.id === context.agentSessionId,
      );
      if (!agentPane) {
        return yield* Effect.fail(
          new WorkflowEngineError({
            code: 'agent_session_not_on_surface',
            message: `Agent session ${context.agentSessionId} was not found on surface ${surface.id}.`,
            worktreeId: worktree.id,
            surfaceId: surface.id,
          }),
        );
      }
      return {
        worktreeId: worktree.id,
        worktreePath: worktree.path,
        surfaceId: surface.id,
        paneId: agentPane.id,
        agentSessionId: context.agentSessionId,
      } satisfies WorkflowLaunchContext;
    }

    const paneId = context.paneId ?? null;
    const pane =
      paneId === null ? null : (surface.panes.find((candidate) => candidate.id === paneId) ?? null);
    if (paneId !== null && !pane) {
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'pane_not_found',
          message: `Pane ${paneId} was not found for surface ${surface.id}.`,
          worktreeId: worktree.id,
          surfaceId: surface.id,
          paneId,
        }),
      );
    }

    return {
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      surfaceId: surface.id,
      paneId,
      agentSessionId: pane?.session?.kind === 'agent_session' ? pane.session.agentSession.id : null,
    } satisfies WorkflowLaunchContext;
  });
}

function worktreePathForRun(run: WorkflowRunRow, workspaceRepository: WorkspaceRepositoryService) {
  return Effect.gen(function* () {
    if (run.worktreeId === null) {
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'worktree_not_found',
          message: `Workflow run ${run.id} has no worktree_id.`,
          workflowRunId: run.id,
        }),
      );
    }
    const worktree = yield* workspaceRepository.findWorktree(run.worktreeId);
    if (!worktree) {
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'worktree_not_found',
          message: `Worktree ${run.worktreeId} for workflow run ${run.id} was not found.`,
          workflowRunId: run.id,
          worktreeId: run.worktreeId,
        }),
      );
    }
    return worktree.path;
  });
}

function persistStepResult(
  services: {
    readonly repository: WorkflowRepositoryService;
    readonly eventBus: import('../runtime-events/index.js').InternalRuntimeEventBusService;
  },
  run: WorkflowRunRow,
  currentState: unknown,
  result: WorkflowResult,
) {
  const { repository, eventBus } = services;
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
    return repository
      .completeDone({ runId: run.id, state: currentState, value: result.value })
      .pipe(Effect.zipRight(publishWorkflowRunTerminal(eventBus, run.id, 'done')));
  }

  if (result.type === 'fail') {
    return repository
      .failRun({
        runId: run.id,
        error: {
          message: result.reason,
          context: { workflowKey: run.workflowKey, returnedFail: true },
        },
        stateSnapshot: { state: currentState },
        thrown: false,
      })
      .pipe(Effect.zipRight(publishWorkflowRunTerminal(eventBus, run.id, 'failed')));
  }

  return repository
    .failRun({
      runId: run.id,
      error: {
        message: `Workflow step returned an unsupported result for run ${run.id}.`,
        context: { workflowKey: run.workflowKey },
      },
      stateSnapshot: { state: currentState },
      thrown: true,
    })
    .pipe(Effect.zipRight(publishWorkflowRunTerminal(eventBus, run.id, 'failed')));
}

function continuePausedRun(input: {
  readonly run: WorkflowRunRow;
  readonly repository: WorkflowRepositoryService;
  readonly artifacts: import('../agent-sessions/index.js').AgentSessionArtifactsService;
  readonly observer: import('../agent-sessions/index.js').HarnessLedgerObserverService;
  readonly headless: WorkflowHeadlessService;
  readonly workspaceRepository: WorkspaceRepositoryService;
  readonly eventBus: import('../runtime-events/index.js').InternalRuntimeEventBusService;
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

  if (input.run.waitKind === 'user_continue' || input.run.waitKind === 'user_input') {
    return input.repository.rearmPausedRun(input.run.id);
  }

  if (input.run.waitKind === 'headless') {
    return continuePausedHeadlessRun(input);
  }

  if (input.run.waitKind === 'workflow') {
    return continuePausedWorkflowRun(input);
  }

  return failWorkflowRunAndPublish({
    repository: input.repository,
    eventBus: input.eventBus,
    run: input.run,
    error: {
      message: `Unsupported workflow continue wait_kind '${input.run.waitKind}'.`,
      context: { workflowRunId: input.run.id, waitKind: input.run.waitKind },
    },
    stateSnapshot: { stateJson: input.run.stateJson },
  });
}

function continuePausedWorkflowRun(input: {
  readonly run: WorkflowRunRow;
  readonly repository: WorkflowRepositoryService;
  readonly eventBus: import('../runtime-events/index.js').InternalRuntimeEventBusService;
  readonly poke: Effect.Effect<void>;
}) {
  return Effect.gen(function* () {
    const condition = parseWorkflowWaitCondition(input.run);
    if (!condition) {
      yield* failWorkflowRunAndPublish({
        repository: input.repository,
        eventBus: input.eventBus,
        run: input.run,
        error: {
          message: `Workflow run ${input.run.id} has an invalid workflow wait_condition.`,
          context: { workflowRunId: input.run.id },
        },
        stateSnapshot: { stateJson: input.run.stateJson },
      });
      return;
    }
    const resolution = yield* input.repository.resolveWorkflowJoin(condition);
    if (resolution.status === 'pending') {
      yield* input.repository.rearmPausedRun(input.run.id);
      return;
    }
    if (resolution.status === 'missing') {
      yield* failWorkflowRunAndPublish({
        repository: input.repository,
        eventBus: input.eventBus,
        run: input.run,
        error: {
          message: `Workflow run ${input.run.id} is waiting on missing workflow run ${resolution.runId}.`,
          context: { workflowRunId: input.run.id, missingWorkflowRunId: resolution.runId },
        },
        stateSnapshot: { stateJson: input.run.stateJson },
      });
      yield* input.poke;
      return;
    }
    yield* input.repository.readyPausedRun({
      runId: input.run.id,
      resumePayload: { kind: 'workflow', results: resolution.results },
    });
    yield* input.poke;
  });
}

function continuePausedHeadlessRun(input: {
  readonly run: WorkflowRunRow;
  readonly repository: WorkflowRepositoryService;
  readonly headless: WorkflowHeadlessService;
  readonly workspaceRepository: WorkspaceRepositoryService;
  readonly eventBus: import('../runtime-events/index.js').InternalRuntimeEventBusService;
  readonly poke: Effect.Effect<void>;
}) {
  return Effect.gen(function* () {
    const condition = parseHeadlessWaitCondition(input.run);
    if (!condition) {
      yield* failWorkflowRunAndPublish({
        repository: input.repository,
        eventBus: input.eventBus,
        run: input.run,
        error: {
          message: `Workflow run ${input.run.id} has an invalid headless wait_condition.`,
          context: { workflowRunId: input.run.id },
        },
        stateSnapshot: { stateJson: input.run.stateJson },
      });
      return;
    }
    const worktreePath = yield* worktreePathForRun(input.run, input.workspaceRepository).pipe(
      Effect.either,
    );
    if (Either.isLeft(worktreePath)) {
      yield* failWorkflowRunAndPublish({
        repository: input.repository,
        eventBus: input.eventBus,
        run: input.run,
        error: stepErrorPayload(worktreePath.left, input.run),
        stateSnapshot: { stateJson: input.run.stateJson },
      });
      return;
    }
    const results = yield* input.headless.completedResults(condition);
    if (results) {
      yield* input.repository.readyPausedRun({
        runId: input.run.id,
        resumePayload: { kind: 'headless', results },
      });
      yield* input.headless.releaseOps({ opIds: condition.ops.map((op) => op.opId) });
      yield* input.poke;
      return;
    }
    const reissued = yield* input.headless
      .reissue({
        runId: input.run.id,
        worktreePath: worktreePath.right,
        ops: condition.ops,
      })
      .pipe(Effect.either);
    if (Either.isLeft(reissued)) {
      yield* failWorkflowRunAndPublish({
        repository: input.repository,
        eventBus: input.eventBus,
        run: input.run,
        error: stepErrorPayload(reissued.left, input.run),
        stateSnapshot: { stateJson: input.run.stateJson },
      });
      return;
    }
    yield* input.repository.rearmPausedRun(input.run.id);
  });
}

function continuePausedTurnRun(input: {
  readonly run: WorkflowRunRow;
  readonly repository: WorkflowRepositoryService;
  readonly artifacts: import('../agent-sessions/index.js').AgentSessionArtifactsService;
  readonly observer: import('../agent-sessions/index.js').HarnessLedgerObserverService;
  readonly eventBus: import('../runtime-events/index.js').InternalRuntimeEventBusService;
  readonly poke: Effect.Effect<void>;
}) {
  return Effect.gen(function* () {
    const condition = parseTurnWaitCondition(input.run);
    if (!condition) {
      yield* failWorkflowRunAndPublish({
        repository: input.repository,
        eventBus: input.eventBus,
        run: input.run,
        error: {
          message: `Workflow run ${input.run.id} has an invalid turn wait_condition.`,
          context: { workflowRunId: input.run.id },
        },
        stateSnapshot: { stateJson: input.run.stateJson },
      });
      return;
    }

    const metadata = yield* input.artifacts.readMetadata(condition.agentSessionId);
    const currentHarnessSessionId =
      metadata.status === 'valid' ? metadata.metadata.harnessSessionId : null;
    if (currentHarnessSessionId !== condition.harnessSessionId) {
      yield* failWorkflowRunAndPublish({
        repository: input.repository,
        eventBus: input.eventBus,
        run: input.run,
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
        stateSnapshot: { stateJson: input.run.stateJson },
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
      yield* input.repository.rearmPausedRun(input.run.id);
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

function reconcileArmedHeadlessWait(input: {
  readonly runId: number;
  readonly condition: Extract<WorkflowWaitCondition, { readonly kind: 'headless' }>;
  readonly repository: WorkflowRepositoryService;
  readonly headless: WorkflowHeadlessService;
  readonly poke: Effect.Effect<void>;
}) {
  return Effect.gen(function* () {
    const results = yield* input.headless.completedResults(input.condition);
    if (!results) return;
    const woke = yield* input.repository.wakeWaitingRun({
      runId: input.runId,
      resumePayload: { kind: 'headless', results },
    });
    if (woke) {
      yield* input.headless.releaseOps({ opIds: input.condition.ops.map((op) => op.opId) });
      yield* input.poke;
    }
  });
}

function reconcileArmedWorkflowWait(input: {
  readonly run: WorkflowRunRow;
  readonly condition: Extract<WorkflowWaitCondition, { readonly kind: 'workflow' }>;
  readonly repository: WorkflowRepositoryService;
  readonly eventBus: import('../runtime-events/index.js').InternalRuntimeEventBusService;
  readonly poke: Effect.Effect<void>;
}) {
  return Effect.gen(function* () {
    const resolution = yield* input.repository.resolveWorkflowJoin(input.condition);
    if (resolution.status === 'pending') return;
    if (resolution.status === 'missing') {
      yield* failWorkflowRunAndPublish({
        repository: input.repository,
        eventBus: input.eventBus,
        run: input.run,
        error: {
          message: `Workflow run ${input.run.id} is waiting on missing workflow run ${resolution.runId}.`,
          context: { workflowRunId: input.run.id, missingWorkflowRunId: resolution.runId },
        },
        stateSnapshot: { stateJson: input.run.stateJson },
      });
      yield* input.poke;
      return;
    }
    const woke = yield* input.repository.wakeWaitingRun({
      runId: input.run.id,
      resumePayload: { kind: 'workflow', results: resolution.results },
    });
    if (woke) yield* input.poke;
  });
}

function failWorkflowRunAndPublish(input: {
  readonly repository: WorkflowRepositoryService;
  readonly eventBus: import('../runtime-events/index.js').InternalRuntimeEventBusService;
  readonly run: WorkflowRunRow;
  readonly error: WorkflowRunErrorPayload;
  readonly stateSnapshot: { readonly state: unknown } | { readonly stateJson: string };
}) {
  return input.repository
    .failRun({
      runId: input.run.id,
      error: input.error,
      stateSnapshot: input.stateSnapshot,
      thrown: true,
    })
    .pipe(Effect.zipRight(publishWorkflowRunTerminal(input.eventBus, input.run.id, 'failed')));
}

function publishWorkflowRunTerminal(
  eventBus: import('../runtime-events/index.js').InternalRuntimeEventBusService,
  runId: number,
  status: 'done' | 'failed',
) {
  return eventBus.publish({ type: 'workflow_run_terminal', runId, status });
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

function parseUserInputWaitCondition(run: WorkflowRunRow) {
  if (!run.waitCondition) return null;
  try {
    const parsed = JSON.parse(run.waitCondition) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed as { readonly kind?: unknown }).kind === 'user_input' &&
      Array.isArray((parsed as { readonly questions?: unknown }).questions)
    ) {
      return parsed as Extract<WorkflowWaitCondition, { readonly kind: 'user_input' }>;
    }
    return null;
  } catch {
    return null;
  }
}

function parseHeadlessWaitCondition(run: WorkflowRunRow) {
  if (!run.waitCondition) return null;
  try {
    const parsed = JSON.parse(run.waitCondition) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed as { readonly kind?: unknown }).kind === 'headless' &&
      Array.isArray((parsed as { readonly ops?: unknown }).ops)
    ) {
      return parsed as Extract<WorkflowWaitCondition, { readonly kind: 'headless' }>;
    }
    return null;
  } catch {
    return null;
  }
}

function parseWorkflowWaitCondition(run: WorkflowRunRow) {
  if (!run.waitCondition) return null;
  try {
    const parsed = JSON.parse(run.waitCondition) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed as { readonly kind?: unknown }).kind === 'workflow' &&
      Array.isArray((parsed as { readonly runIds?: unknown }).runIds)
    ) {
      return parsed as Extract<WorkflowWaitCondition, { readonly kind: 'workflow' }>;
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

function findRunOrFail(repository: WorkflowRepositoryService, runId: number) {
  return Effect.gen(function* () {
    const run = yield* repository.findRun(runId);
    if (run) return run;
    return yield* Effect.fail(
      new WorkflowEngineError({
        code: 'workflow_run_not_found',
        message: `Workflow run ${runId} was not found.`,
        workflowRunId: runId,
      }),
    );
  });
}

function userInputError(cause: unknown, runId: number) {
  if (cause instanceof WorkflowUserInputValidationError) {
    return new WorkflowEngineError({
      code: 'workflow_user_input_invalid',
      message: cause.message,
      workflowRunId: runId,
    });
  }
  return new WorkflowEngineError({
    code: 'workflow_user_input_invalid',
    message: errorMessage(cause),
    workflowRunId: runId,
  });
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

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
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
  const tag = (cause as { readonly _tag?: unknown })['_tag'];
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
