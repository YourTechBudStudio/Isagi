import { Cause, Context, Effect, Either, Layer, Queue } from 'effect';

import { AgentSessionArtifacts, AgentSessionService } from '../agent-sessions/index.js';
import { HarnessLedgerObserver } from '../agent-sessions/index.js';
import { diagnosticPhase } from '../diagnostics/phase.js';
import type { DatabaseError } from '../persistence/index.js';
import { PtyService } from '../pty-processes/index.js';
import { InternalRuntimeEventBus } from '../runtime-events/index.js';
import { SurfaceService } from '../surfaces/index.js';
import type { SurfaceService as SurfaceServiceShape } from '../surfaces/index.js';
import { WorkspaceRepository } from '../workspace/index.js';
import type { WorkspaceRepositoryService } from '../workspace/index.js';
import { workflowContext } from './context.js';
import {
  WorkflowEventLedger,
  type WorkflowEventLedgerService,
  workflowEventLedgerWarningPayload,
} from './event-ledger.service.js';
import { WorkflowHeadless } from './headless.js';
import { WorkflowRegistry } from './registry.js';
import {
  WorkflowRepository,
  type WorkflowRepositoryService,
  type WorkflowRunErrorPayload,
} from './repository.js';
import { startWorkflowResolver } from './resolver.js';
import {
  continuePausedRun,
  reconcileArmedHeadlessWait,
  reconcileArmedTurnWait,
  reconcileArmedWorkflowWait,
} from './resume-paths.js';
import {
  appendLifecycleBestEffort,
  appendInternalWorkflowLogBestEffort,
  errorMessage,
  findRunOrFail,
  publishWorkflowRunTerminal,
  stepErrorPayload,
  unknownWorkflowError,
  unknownWorkflowMessage,
  userInputError,
  worktreePathForRun,
} from './run-failure.js';
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
import { validateWorkflowUserInputAnswers } from './user-input.js';
import { parseResumePayload, parseState, parseUserInputWaitCondition } from './wait-conditions.js';

export interface WorkflowEngineService {
  readonly listWorkflowDescriptors: (input: {
    readonly context: WorkflowStartContextInput;
  }) => Effect.Effect<readonly WorkflowDescriptorResult[], WorkflowEngineServiceError>;
  readonly startWorkflow: (input: {
    readonly workflowKey: string;
    readonly variables: WorkflowVariables;
    readonly context: WorkflowStartContextInput;
  }) => Effect.Effect<WorkflowRunRow, WorkflowEngineServiceError>;
  readonly setPaused: (input: {
    readonly surfaceId: number;
    readonly paused: boolean;
  }) => Effect.Effect<WorkflowSurfaceControlResult, WorkflowEngineServiceError>;
  readonly clear: (input: {
    readonly surfaceId: number;
  }) => Effect.Effect<WorkflowSurfaceControlResult, WorkflowEngineServiceError>;
  readonly retry: (input: {
    readonly surfaceId: number;
  }) => Effect.Effect<WorkflowRunControlResult, WorkflowEngineServiceError>;
  readonly advance: (input: {
    readonly runId: number;
    readonly answers?: Record<string, unknown> | undefined;
  }) => Effect.Effect<WorkflowHumanWaitSatisfactionResult, WorkflowEngineServiceError>;
  readonly drainOnce: Effect.Effect<WorkflowDrainSummary, DatabaseError>;
  readonly poke: Effect.Effect<void>;
}

export interface WorkflowDrainSummary {
  readonly claimed: number;
}

export interface WorkflowSurfaceControlResult {
  readonly surfaceId: number;
}

export interface WorkflowRunControlResult {
  readonly runId: number;
  readonly status: WorkflowRunRow['status'];
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
    const eventLedger = yield* WorkflowEventLedger;
    const wakeQueue = yield* Queue.sliding<void>(1);
    const owner = `workflow-engine:${process.pid}:${Date.now()}`;

    const poke = wakeQueue.offer(void 0).pipe(Effect.asVoid);

    const failRun = (
      run: WorkflowRunRow,
      error: WorkflowRunErrorPayload,
      stateSnapshot: { readonly state: unknown } | { readonly stateJson: string },
    ) =>
      appendInternalWorkflowLogBestEffort(
        eventLedger,
        run,
        'error',
        `Workflow run ${run.id} failed while executing: ${error.message}`,
      ).pipe(
        Effect.zipRight(repository.failRun({ runId: run.id, error, stateSnapshot, thrown: true })),
        Effect.zipRight(appendLifecycleBestEffort(eventLedger, run, 'failed')),
        Effect.zipRight(publishWorkflowRunTerminal(eventBus, run.id, 'failed')),
      );

    const startWorkflowRun = (input: {
      readonly workflowKey: string;
      readonly variables: WorkflowVariables;
      readonly context: WorkflowStartContextInput;
      readonly parentRun?: WorkflowRunRow | undefined;
    }) =>
      Effect.gen(function* () {
        const diagnosticContext = {
          workflowKey: input.workflowKey,
          parentRunId: input.parentRun?.id ?? null,
          worktreeId: input.context.worktreeId,
          surfaceId: input.context.surfaceId,
          paneId: input.context.paneId ?? null,
          agentSessionId: input.context.agentSessionId ?? null,
        };
        const definition = yield* diagnosticPhase(
          'workflow.start.load_definition',
          diagnosticContext,
          registry.get(input.workflowKey).pipe(Effect.either),
        );
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
        const launchCtx = yield* diagnosticPhase(
          'workflow.start.build_launch_context',
          diagnosticContext,
          buildLaunchContext(input.context, {
            workspaceRepository,
            surfaces,
          }),
        );
        const launchContextDiagnostics = {
          ...diagnosticContext,
          resolvedPaneId: launchCtx.paneId,
          resolvedAgentSessionId: launchCtx.agentSessionId,
        };
        const manifest = yield* diagnosticPhase(
          'workflow.start.command_manifest',
          launchContextDiagnostics,
          Effect.tryPromise({
            try: async () => loadedDefinition.command(launchCtx),
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
          ),
        );
        if (!input.parentRun) {
          if (launchCtx.surfaceId === null) {
            return yield* Effect.fail(
              new WorkflowEngineError({
                code: 'workflow_root_surface_required',
                message: `Workflow '${input.workflowKey}' cannot start without a surface.`,
                workflowKey: input.workflowKey,
              }),
            );
          }
          const activeRoot = yield* diagnosticPhase(
            'workflow.start.find_active_root',
            launchContextDiagnostics,
            repository.findLatestRootRunForSurface(launchCtx.surfaceId),
          );
          if (activeRoot) {
            return yield* Effect.fail(
              new WorkflowEngineError({
                code: 'workflow_surface_busy',
                message: `Surface ${launchCtx.surfaceId} already has a workflow.`,
                workflowKey: input.workflowKey,
                activeWorkflowRunId: activeRoot.id,
                surfaceId: launchCtx.surfaceId,
              }),
            );
          }
        }
        const validated = yield* diagnosticPhase(
          'workflow.start.validate',
          launchContextDiagnostics,
          Effect.tryPromise({
            try: async () => loadedDefinition.validate(launchCtx, input.variables),
            catch: (cause) => cause,
          }).pipe(Effect.either),
        );
        if (Either.isLeft(validated)) {
          return yield* Effect.fail(
            new WorkflowEngineError({
              code: 'validation_failed',
              message: errorMessage(validated.left),
              workflowKey: input.workflowKey,
            }),
          );
        }
        const initialState = yield* diagnosticPhase(
          'workflow.start.init',
          launchContextDiagnostics,
          Effect.tryPromise({
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
          ),
        );
        const run = yield* diagnosticPhase(
          'workflow.start.create_run',
          launchContextDiagnostics,
          repository.createRun({
            workflowKey: input.workflowKey,
            workflowTitle: manifest.title,
            state: initialState,
            stateVersion: 1,
            worktreeId: launchCtx.worktreeId,
            surfaceId: launchCtx.surfaceId,
            parentRunId: input.parentRun?.id ?? null,
            rootRunId: input.parentRun?.rootRunId ?? input.parentRun?.id ?? null,
          }),
        );
        const runDiagnostics = { ...launchContextDiagnostics, workflowRunId: run.id };
        yield* appendInternalWorkflowLogBestEffort(
          eventLedger,
          run,
          'info',
          `Workflow run ${run.id} created for '${input.workflowKey}' on surface ${launchCtx.surfaceId ?? 'none'}.`,
        );
        yield* diagnosticPhase(
          'workflow.start.append_lifecycle',
          runDiagnostics,
          appendLifecycleBestEffort(eventLedger, run, 'started'),
        );
        yield* poke;
        return run;
      });

    const runClaimedStep = (run: WorkflowRunRow) =>
      Effect.gen(function* () {
        const phaseContext = {
          workflowRunId: run.id,
          workflowKey: run.workflowKey,
          status: run.status,
          waitKind: run.waitKind,
          owner: run.owner,
        };
        const definition = yield* diagnosticPhase(
          'workflow.claimed.load_definition',
          phaseContext,
          registry.get(run.workflowKey),
        ).pipe(Effect.either);
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
        const worktreePath = yield* diagnosticPhase(
          'workflow.claimed.resolve_worktree_path',
          phaseContext,
          worktreePathForRun(run, workspaceRepository),
        ).pipe(Effect.either);
        if (Either.isLeft(worktreePath)) {
          yield* failRun(run, stepErrorPayload(worktreePath.left, run), {
            stateJson: run.stateJson,
          });
          return;
        }

        // Built directly (not as a diagnostic phase): constructing the context is
        // synchronous and can't stall the loop, so a marker/phase would be noise.
        const ctx = workflowContext({
          repository,
          run,
          agents,
          surfaces,
          pty,
          artifacts,
          observer,
          headless,
          eventLedger,
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
                parentRun,
              });
            }),
        });
        const state = yield* diagnosticPhase(
          'workflow.claimed.parse_state',
          phaseContext,
          Effect.try({
            try: () => parseState(run),
            catch: (cause) => cause,
          }),
        ).pipe(Effect.either);
        if (Either.isLeft(state)) {
          yield* failRun(run, stepErrorPayload(state.left, run), { stateJson: run.stateJson });
          return;
        }
        const event = yield* diagnosticPhase(
          'workflow.claimed.parse_resume_payload',
          phaseContext,
          Effect.try({
            try: () => parseResumePayload(run),
            catch: (cause) => cause,
          }),
        ).pipe(Effect.either);
        if (Either.isLeft(event)) {
          yield* failRun(run, stepErrorPayload(event.left, run), { state: state.right });
          return;
        }
        yield* appendInternalWorkflowLogBestEffort(
          eventLedger,
          run,
          'debug',
          `Executing workflow step for run ${run.id}: ${workflowStateSummary(state.right)}; event=${workflowEventSummary(event.right)}.`,
        );
        const result = yield* diagnosticPhase(
          'workflow.claimed.step',
          phaseContext,
          Effect.tryPromise({
            try: async () => loadedDefinition.step(ctx, state.right, event.right),
            catch: (cause) => cause,
          }),
        ).pipe(Effect.either);

        const cancelled = yield* reapIfCancelRequested({ repository, eventLedger, run });
        if (cancelled) {
          yield* appendInternalWorkflowLogBestEffort(
            eventLedger,
            run,
            'info',
            `Workflow run ${run.id} was cancelled after the step returned.`,
          );
          return;
        }

        if (Either.isLeft(result)) {
          yield* failRun(run, stepErrorPayload(result.left, run), { state: state.right });
          return;
        }

        yield* appendInternalWorkflowLogBestEffort(
          eventLedger,
          run,
          'debug',
          `Workflow step for run ${run.id} returned ${workflowResultSummary(result.right)}.`,
        );
        yield* persistStepResult(
          { repository, eventBus, eventLedger },
          run,
          state.right,
          result.right,
        );
        // Close the suspend-commit race. A turn can finish in the window between
        // the step returning and `completeSuspend` persisting the `waiting` row.
        // The bus is edge-triggered and lossy, so a `turn_ended` published in that
        // window finds no `waiting` row in the resolver and is dropped — stranding
        // the run in `waiting` until the next restart re-pauses it for a user-gated
        // continue. The ledger is the source of truth, so re-evaluate the wait we
        // just armed against it; an already-landed terminal edge wakes the run now.
        if (result.right.type === 'suspend' && result.right.condition.kind === 'turn') {
          yield* reconcileArmedTurnWait({
            run,
            condition: result.right.condition,
            repository,
            observer,
            eventLedger,
            poke,
          });
        }
        if (result.right.type === 'suspend' && result.right.condition.kind === 'headless') {
          yield* reconcileArmedHeadlessWait({
            run,
            condition: result.right.condition,
            repository,
            headless,
            eventLedger,
            poke,
          });
        }
        if (result.right.type === 'suspend' && result.right.condition.kind === 'workflow') {
          yield* reconcileArmedWorkflowWait({
            run,
            condition: result.right.condition,
            repository,
            eventBus,
            eventLedger,
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
          if (readyRun.cancelRequested) {
            yield* repository.deleteRunTree({
              rootRunId: readyRun.rootRunId ?? readyRun.id,
              surfaceId: readyRun.surfaceId,
            });
            continue;
          }
          const claimedRun = yield* repository.claimReadyRun({ runId: readyRun.id, owner });
          if (!claimedRun) continue;
          claimed += 1;
          // Per-step churn: debug-gated so it stays out of the default narrative. The
          // milestone lines (created/suspended/resumed/done/failed) stay at info.
          yield* appendInternalWorkflowLogBestEffort(
            eventLedger,
            claimedRun,
            'debug',
            `Workflow run ${claimedRun.id} claimed by ${owner}; executing now.`,
          );
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
      setPaused: (input) =>
        Effect.gen(function* () {
          const root = yield* repository.findNonTerminalRootRunForSurface(input.surfaceId);
          if (!root || root.rootRunId === null) {
            return yield* Effect.fail(
              new WorkflowEngineError({
                code: 'workflow_run_not_found',
                message: `Surface ${input.surfaceId} does not have a non-terminal workflow.`,
                surfaceId: input.surfaceId,
              }),
            );
          }
          const pausedRunsBeforeResume = input.paused
            ? []
            : (yield* repository.listRunTree(root.rootRunId)).filter((run) => run.paused);
          yield* repository.setPausedForRunTree({
            rootRunId: root.rootRunId,
            paused: input.paused,
          });
          if (!input.paused) {
            for (const run of pausedRunsBeforeResume) {
              yield* continuePausedRun({
                run,
                repository,
                artifacts,
                observer,
                headless,
                eventLedger,
                workspaceRepository,
                eventBus,
                poke,
              });
            }
            yield* poke;
          }
          return { surfaceId: input.surfaceId };
        }),
      clear: (input) =>
        Effect.gen(function* () {
          const root = yield* repository.findLatestRootRunForSurface(input.surfaceId);
          if (!root || root.rootRunId === null) {
            return yield* Effect.fail(
              new WorkflowEngineError({
                code: 'workflow_run_not_found',
                message: `Surface ${input.surfaceId} does not have a workflow to clear.`,
                surfaceId: input.surfaceId,
              }),
            );
          }
          const runs = yield* repository.listRunTree(root.rootRunId);
          if (runs.some((run) => run.status === 'running')) {
            yield* repository.requestCancelForRunTree(root.rootRunId);
          } else {
            yield* eventLedger.deleteRunTreeLedgers(root.rootRunId).pipe(
              Effect.catchAll((error) =>
                Effect.sync(() => {
                  console.warn('[runtime] Workflow clear ledger cleanup failed', {
                    op: 'clear',
                    ...workflowEventLedgerWarningPayload(error),
                  });
                }),
              ),
            );
            yield* repository.deleteRunTree({
              rootRunId: root.rootRunId,
              surfaceId: root.surfaceId,
            });
          }
          return { surfaceId: input.surfaceId };
        }),
      retry: (input) =>
        Effect.gen(function* () {
          const activeRoot = yield* repository.findNonTerminalRootRunForSurface(input.surfaceId);
          if (activeRoot) {
            return yield* Effect.fail(
              new WorkflowEngineError({
                code: 'workflow_surface_busy',
                message: `Surface ${input.surfaceId} already has a running workflow.`,
                activeWorkflowRunId: activeRoot.id,
                surfaceId: input.surfaceId,
              }),
            );
          }
          const failedRoot = yield* repository.findFailedRootRunForSurface(input.surfaceId);
          if (!failedRoot) {
            return yield* Effect.fail(
              new WorkflowEngineError({
                code: 'workflow_run_not_failed',
                message: `Surface ${input.surfaceId} does not have a failed workflow to retry.`,
                surfaceId: input.surfaceId,
              }),
            );
          }
          const retried = yield* repository.retryFailedRun(failedRoot.id);
          if (!retried) {
            return yield* Effect.fail(
              new WorkflowEngineError({
                code: 'workflow_run_not_failed',
                message: `Workflow run ${failedRoot.id} is not failed.`,
                workflowRunId: failedRoot.id,
                surfaceId: input.surfaceId,
              }),
            );
          }
          yield* appendInternalWorkflowLogBestEffort(
            eventLedger,
            retried,
            'info',
            `Workflow run ${retried.id} retried; run is ready for execution.`,
          );
          yield* poke;
          return { runId: retried.id, status: retried.status };
        }),
      advance: (input) =>
        Effect.gen(function* () {
          const run = yield* findRunOrFail(repository, input.runId);
          if (run.status !== 'waiting') return { outcome: 'already_resolved', run } as const;
          if (run.waitKind === 'user_continue') {
            const woke = yield* repository.wakeWaitingRun({
              runId: run.id,
              resumePayload: { kind: 'user_continue' },
            });
            if (!woke) {
              const current = yield* repository.findRun(run.id);
              return { outcome: 'already_resolved', run: current ?? run } as const;
            }
            yield* appendInternalWorkflowLogBestEffort(
              eventLedger,
              run,
              'info',
              `User continue received for run ${run.id}; run is ready to resume.`,
            );
            yield* appendLifecycleBestEffort(eventLedger, run, 'resumed');
            yield* poke;
            const current = yield* repository.findRun(run.id);
            return { outcome: 'satisfied', run: current ?? run } as const;
          }
          if (run.waitKind !== 'user_input') {
            return yield* Effect.fail(
              new WorkflowEngineError({
                code: 'workflow_wait_not_satisfiable',
                message: `Workflow run ${run.id} is waiting on '${run.waitKind ?? 'none'}', not a user wait.`,
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
                answers: input.answers ?? {},
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
          yield* appendInternalWorkflowLogBestEffort(
            eventLedger,
            run,
            'info',
            `User input received for run ${run.id}; run is ready to resume.`,
          );
          yield* appendLifecycleBestEffort(eventLedger, run, 'resumed');
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
    yield* startWorkflowResolver({
      repository,
      engine: service,
      eventBus,
      headless,
      observer,
      eventLedger,
    });

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
      if (
        context.paneId !== undefined &&
        context.paneId !== null &&
        context.paneId !== agentPane.id
      ) {
        return yield* Effect.fail(
          new WorkflowEngineError({
            code: 'workflow_launch_context_mismatch',
            message: `Workflow launch context supplied pane ${context.paneId} with agent session ${context.agentSessionId}, but agent session ${context.agentSessionId} belongs to pane ${agentPane.id} on surface ${surface.id}.`,
            worktreeId: worktree.id,
            surfaceId: surface.id,
            paneId: context.paneId,
            agentSessionId: context.agentSessionId,
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

function persistStepResult(
  services: {
    readonly repository: WorkflowRepositoryService;
    readonly eventBus: import('../runtime-events/index.js').InternalRuntimeEventBusService;
    readonly eventLedger: WorkflowEventLedgerService;
  },
  run: WorkflowRunRow,
  currentState: unknown,
  result: WorkflowResult,
) {
  const { repository, eventBus, eventLedger } = services;
  if (result.type === 'cont') {
    return repository
      .completeCont({ runId: run.id, state: result.state })
      .pipe(
        Effect.zipRight(
          appendInternalWorkflowLogBestEffort(
            eventLedger,
            run,
            'debug',
            `Workflow run ${run.id} state persisted; run is ready for the next step.`,
          ),
        ),
      );
  }

  if (result.type === 'suspend') {
    return repository
      .completeSuspend({
        runId: run.id,
        state: result.state,
        waitKind: waitKind(result.condition),
        waitCondition: result.condition,
      })
      .pipe(
        Effect.zipRight(
          appendInternalWorkflowLogBestEffort(
            eventLedger,
            run,
            'info',
            `Workflow run ${run.id} suspended on ${workflowWaitConditionSummary(result.condition)}.`,
          ),
        ),
        Effect.zipRight(appendLifecycleBestEffort(eventLedger, run, 'suspended')),
      );
  }

  if (result.type === 'done') {
    return repository
      .completeDone({ runId: run.id, state: currentState, value: result.value })
      .pipe(Effect.zipRight(appendLifecycleBestEffort(eventLedger, run, 'done')))
      .pipe(
        Effect.zipRight(
          appendInternalWorkflowLogBestEffort(
            eventLedger,
            run,
            'info',
            `Workflow run ${run.id} completed.`,
          ),
        ),
      )
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
      .pipe(
        Effect.zipRight(
          appendInternalWorkflowLogBestEffort(
            eventLedger,
            run,
            'error',
            `Workflow run ${run.id} failed by workflow result: ${result.reason}`,
          ),
        ),
      )
      .pipe(Effect.zipRight(appendLifecycleBestEffort(eventLedger, run, 'failed')))
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
    .pipe(Effect.zipRight(appendLifecycleBestEffort(eventLedger, run, 'failed')))
    .pipe(Effect.zipRight(publishWorkflowRunTerminal(eventBus, run.id, 'failed')));
}

function reapIfCancelRequested(input: {
  readonly repository: WorkflowRepositoryService;
  readonly eventLedger: WorkflowEventLedgerService;
  readonly run: WorkflowRunRow;
}) {
  return Effect.gen(function* () {
    const current = yield* input.repository.findRun(input.run.id);
    if (!current?.cancelRequested) return false;
    const rootRunId = current.rootRunId ?? current.id;
    yield* input.eventLedger.deleteRunTreeLedgers(rootRunId).pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => {
          console.warn('[runtime] Workflow cancel ledger cleanup failed', {
            op: 'cancel',
            ...workflowEventLedgerWarningPayload(error),
          });
        }),
      ),
    );
    yield* input.repository.deleteRunTree({
      rootRunId,
      surfaceId: current.surfaceId,
    });
    return true;
  });
}

function workflowStateSummary(state: unknown) {
  if (!state || typeof state !== 'object') return 'state=unknown';
  const record = state as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof record.phase === 'string') parts.push(`phase=${record.phase}`);
  if (typeof record.currentPhase === 'number') parts.push(`currentPhase=${record.currentPhase}`);
  if (typeof record.phaseCount === 'number') parts.push(`phaseCount=${record.phaseCount}`);
  if (isRecord(record.awaiting) && typeof record.awaiting.kind === 'string') {
    parts.push(`awaiting=${record.awaiting.kind}`);
  }
  if (isRecord(record.pauseReason) && typeof record.pauseReason.kind === 'string') {
    parts.push(`pauseReason=${record.pauseReason.kind}`);
  }
  return parts.length > 0 ? parts.join(', ') : 'state=object';
}

function workflowEventSummary(event: unknown) {
  if (event === undefined) return 'none';
  if (!event || typeof event !== 'object') return typeof event;
  const record = event as Record<string, unknown>;
  if (typeof record.kind === 'string') return record.kind;
  if (typeof record.outcome === 'string') {
    const recordedAt = typeof record.recordedAt === 'string' ? ` at ${record.recordedAt}` : '';
    return `${record.outcome}${recordedAt}`;
  }
  return 'object';
}

function workflowResultSummary(result: WorkflowResult) {
  if (result.type === 'suspend') {
    return `suspend(${workflowWaitConditionSummary(result.condition)})`;
  }
  if (result.type === 'fail') return `fail(${result.reason})`;
  return result.type;
}

function workflowWaitConditionSummary(condition: WorkflowWaitCondition) {
  if (condition.kind === 'turn') {
    return `turn agentSessionId=${condition.agentSessionId} harnessSessionId=${condition.harnessSessionId}`;
  }
  if (condition.kind === 'headless') {
    return `headless ops=${condition.ops.map((op) => op.opId).join(',')}`;
  }
  if (condition.kind === 'workflow') {
    return `workflow runIds=${condition.runIds.join(',')}`;
  }
  if (condition.kind === 'user_input') {
    return `user_input questions=${condition.questions.map((question) => question.key).join(',')}`;
  }
  return condition.kind;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function logDrainFailure(label: string) {
  return (cause: Cause.Cause<unknown>) =>
    Effect.sync(() => {
      console.warn(`[runtime] Workflow engine drain failed (${label})`, Cause.pretty(cause));
    });
}
