import { resolve } from 'node:path';

import { Cause, Context, Effect, Either, Layer, Queue, Schema } from 'effect';

import { workflowCommandManifestSchema } from '@isagi/contracts';

import { AgentSessionArtifacts } from '../agent-sessions/index.js';
import { HarnessLedgerObserver } from '../agent-sessions/index.js';
import { diagnosticPhase } from '../diagnostics/phase.js';
import type { DatabaseError } from '../persistence/index.js';
import { InternalRuntimeEventBus } from '../runtime-events/index.js';
import { SurfaceService } from '../surfaces/index.js';
import type { SurfaceService as SurfaceServiceShape } from '../surfaces/index.js';
import { WorkspaceRepository } from '../workspace/index.js';
import type { WorkspaceRepositoryService } from '../workspace/index.js';
import { WorkflowCapabilities } from './capabilities.js';
import { workflowContext } from './context.js';
import {
  WorkflowEventLedger,
  type WorkflowEventLedgerService,
  workflowEventLedgerWarningPayload,
} from './event-ledger.service.js';
import { WorkflowHeadless } from './headless.js';
import { WorkflowLoadError } from './loader.js';
import { WorkflowRegistry, type WorkflowRegistryContext } from './registry.js';
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
  readonly verifyWorkflow: (input: {
    readonly workflowKey: string;
    readonly worktreePath: string;
  }) => Effect.Effect<WorkflowVerifyResult, WorkflowEngineServiceError>;
  readonly listWorkflowDescriptors: (input: {
    readonly context: WorkflowStartContextInput;
  }) => Effect.Effect<readonly WorkflowDescriptorResult[], WorkflowEngineServiceError>;
  readonly startWorkflow: (input: {
    readonly workflowKey: string;
    readonly variables: WorkflowVariables;
    readonly context: WorkflowStartContextInput;
  }) => Effect.Effect<WorkflowRunRow, WorkflowEngineServiceError>;
  readonly pause: (input: {
    readonly runId: number;
  }) => Effect.Effect<WorkflowRunControlResult, WorkflowEngineServiceError>;
  readonly resume: (input: {
    readonly runId: number;
  }) => Effect.Effect<WorkflowRunControlResult, WorkflowEngineServiceError>;
  readonly clear: (input: {
    readonly runId: number;
  }) => Effect.Effect<WorkflowRunControlResult, WorkflowEngineServiceError>;
  readonly retry: (input: {
    readonly runId: number;
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

export type WorkflowVerifyScope =
  | { readonly kind: 'project'; readonly projectId: number }
  | { readonly kind: 'global' };

export type WorkflowVerifyDiagnosticStage = 'resolve' | 'compile' | 'load' | 'shape' | 'command';

export interface WorkflowVerifyDiagnostic {
  readonly stage: WorkflowVerifyDiagnosticStage;
  readonly message: string;
}

export type WorkflowVerifyResult =
  | {
      readonly ok: true;
      readonly workflowKey: string;
      readonly scope: WorkflowVerifyScope;
      readonly manifest: WorkflowCommandManifest;
    }
  | {
      readonly ok: false;
      readonly workflowKey: string;
      readonly scope: WorkflowVerifyScope;
      readonly diagnostics: readonly WorkflowVerifyDiagnostic[];
    };

export const WorkflowEngine = Context.GenericTag<WorkflowEngineService>('isagi/WorkflowEngine');

export const WorkflowEngineLive = Layer.scoped(
  WorkflowEngine,
  Effect.gen(function* () {
    const repository = yield* WorkflowRepository;
    const registry = yield* WorkflowRegistry;
    const workspaceRepository = yield* WorkspaceRepository;
    const eventBus = yield* InternalRuntimeEventBus;
    const surfaces = yield* SurfaceService;
    const artifacts = yield* AgentSessionArtifacts;
    const observer = yield* HarnessLedgerObserver;
    const headless = yield* WorkflowHeadless;
    const eventLedger = yield* WorkflowEventLedger;
    const capabilities = yield* WorkflowCapabilities;
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
        const registryContext = yield* workflowRegistryContextForWorktreeId(
          input.context.worktreeId,
          workspaceRepository,
        );
        const definition = yield* diagnosticPhase(
          'workflow.start.load_definition',
          diagnosticContext,
          registry.get(input.workflowKey, registryContext).pipe(Effect.either),
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
          const knownWorkflowKeys = yield* registry.knownKeys(registryContext).pipe(
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
          workflowRegistryContextForRun(run, workspaceRepository).pipe(
            Effect.flatMap((registryContext) => registry.get(run.workflowKey, registryContext)),
          ),
        ).pipe(Effect.either);
        if (Either.isLeft(definition)) {
          yield* failRun(run, stepErrorPayload(definition.left, run), { stateJson: run.stateJson });
          return;
        }
        if (!definition.right) {
          const knownWorkflowKeys = yield* workflowRegistryContextForRun(
            run,
            workspaceRepository,
          ).pipe(
            Effect.flatMap((registryContext) => registry.knownKeys(registryContext)),
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
          run,
          capabilities,
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
        if (result.right.type === 'suspend' && result.right.condition.kind === 'agent_turn') {
          yield* reconcileArmedTurnWait({
            run,
            condition: result.right.condition,
            repository,
            observer,
            eventLedger,
            poke,
          });
        }
        if (result.right.type === 'suspend' && result.right.condition.kind === 'headless_agent') {
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

    const findRootRunForOperation = (runId: number, operation: string) =>
      Effect.gen(function* () {
        const run = yield* findRunOrFail(repository, runId);
        if (run.parentRunId !== null || run.rootRunId !== run.id) {
          return yield* Effect.fail(
            new WorkflowEngineError({
              code: 'workflow_root_run_required',
              message: `Workflow operation '${operation}' requires a root run id.`,
              workflowRunId: run.id,
              surfaceId: run.surfaceId ?? undefined,
              operation,
            }),
          );
        }
        return run;
      });

    const setPausedForRootRun = (runId: number, paused: boolean, operation: string) =>
      Effect.gen(function* () {
        const root = yield* findRootRunForOperation(runId, operation);
        if (root.status === 'done' || root.status === 'failed') {
          return yield* Effect.fail(
            new WorkflowEngineError({
              code: 'workflow_run_not_found',
              message: `Workflow run ${root.id} does not have a non-terminal workflow.`,
              workflowRunId: root.id,
              surfaceId: root.surfaceId ?? undefined,
            }),
          );
        }
        const pausedRunsBeforeResume = paused
          ? []
          : (yield* repository.listRunTree(root.id)).filter((run) => run.paused);
        yield* repository.setPausedForRunTree({
          rootRunId: root.id,
          paused,
        });
        if (!paused) {
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
        const current = yield* repository.findRun(root.id);
        return { runId: root.id, status: current?.status ?? root.status };
      });

    const resolveVerifyScope = (worktreePath: string) =>
      Effect.gen(function* () {
        const normalizedWorktreePath = normalizeWorktreePath(worktreePath);
        const worktrees = yield* workspaceRepository.listWorktrees;
        const worktree = worktrees.find(
          (candidate) => normalizeWorktreePath(candidate.path) === normalizedWorktreePath,
        );
        if (!worktree) {
          return {
            normalizedWorktreePath,
            scope: { kind: 'global' } as const,
            registryContext: undefined,
            diagnostics: [],
          };
        }

        const project = yield* workspaceRepository.findProject(worktree.projectId);
        if (!project) {
          return {
            normalizedWorktreePath,
            scope: { kind: 'global' } as const,
            registryContext: undefined,
            diagnostics: [
              {
                stage: 'resolve' as const,
                message: `Project ${worktree.projectId} for matched worktree ${worktree.id} was not found.`,
              },
            ],
          };
        }

        return {
          normalizedWorktreePath,
          scope: { kind: 'project', projectId: project.id } as const,
          registryContext: {
            projectId: project.id,
            projectRoot: project.rootPath,
          } satisfies WorkflowRegistryContext,
          diagnostics: [],
        };
      });

    const verifyWorkflow = (input: {
      readonly workflowKey: string;
      readonly worktreePath: string;
    }) =>
      Effect.gen(function* () {
        const resolved = yield* resolveVerifyScope(input.worktreePath);
        if (resolved.diagnostics.length > 0) {
          return {
            ok: false,
            workflowKey: input.workflowKey,
            scope: resolved.scope,
            diagnostics: resolved.diagnostics,
          } satisfies WorkflowVerifyResult;
        }

        const definitionResult = yield* registry
          .get(input.workflowKey, resolved.registryContext)
          .pipe(Effect.either);
        if (Either.isLeft(definitionResult)) {
          return {
            ok: false,
            workflowKey: input.workflowKey,
            scope: resolved.scope,
            diagnostics: [workflowLoadDiagnostic(definitionResult.left)],
          } satisfies WorkflowVerifyResult;
        }
        if (!definitionResult.right) {
          const knownKeys = yield* registry.knownKeys(resolved.registryContext).pipe(Effect.either);
          const knownMessage = Either.isRight(knownKeys)
            ? ` Known workflow keys: ${knownKeys.right.length > 0 ? knownKeys.right.join(', ') : '(none)'}.`
            : ` Could not list known workflow keys: ${knownKeys.left.message}`;
          return {
            ok: false,
            workflowKey: input.workflowKey,
            scope: resolved.scope,
            diagnostics: [
              {
                stage: 'resolve',
                message: `Workflow '${input.workflowKey}' was not found.${knownMessage}`,
              },
            ],
          } satisfies WorkflowVerifyResult;
        }
        const definition = definitionResult.right;

        const launchCtx = {
          worktreeId: 0,
          worktreePath: resolved.normalizedWorktreePath,
          surfaceId: 0,
        };
        const manifestResult = yield* Effect.tryPromise({
          try: async () => definition.command(launchCtx),
          catch: (cause) => cause,
        }).pipe(Effect.either);
        if (Either.isLeft(manifestResult)) {
          return {
            ok: false,
            workflowKey: input.workflowKey,
            scope: resolved.scope,
            diagnostics: [{ stage: 'command', message: errorMessage(manifestResult.left) }],
          } satisfies WorkflowVerifyResult;
        }

        const manifest = yield* Effect.sync(() =>
          Schema.decodeUnknownSync(workflowCommandManifestSchema)(manifestResult.right),
        ).pipe(Effect.either);
        if (Either.isLeft(manifest)) {
          return {
            ok: false,
            workflowKey: input.workflowKey,
            scope: resolved.scope,
            diagnostics: [{ stage: 'command', message: errorMessage(manifest.left) }],
          } satisfies WorkflowVerifyResult;
        }

        return {
          ok: true,
          workflowKey: input.workflowKey,
          scope: resolved.scope,
          manifest: manifest.right,
        } satisfies WorkflowVerifyResult;
      });

    const service = {
      verifyWorkflow,
      listWorkflowDescriptors: (input) =>
        Effect.gen(function* () {
          const launchCtx = yield* buildLaunchContext(input.context, {
            workspaceRepository,
            surfaces,
          });
          const registryContext = yield* workflowRegistryContextForWorktreeId(
            launchCtx.worktreeId,
            workspaceRepository,
          );
          const keys = yield* registry.knownKeys(registryContext).pipe(
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
            const definition = yield* registry
              .get(workflowKey, registryContext)
              .pipe(Effect.either);
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
      pause: (input) => setPausedForRootRun(input.runId, true, 'pause'),
      resume: (input) => setPausedForRootRun(input.runId, false, 'resume'),
      clear: (input) =>
        Effect.gen(function* () {
          const root = yield* findRootRunForOperation(input.runId, 'clear');
          const runs = yield* repository.listRunTree(root.id);
          if (runs.some((run) => run.status === 'running')) {
            yield* repository.requestCancelForRunTree(root.id);
          } else {
            yield* eventLedger.deleteRunTreeLedgers(root.id).pipe(
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
              rootRunId: root.id,
              surfaceId: root.surfaceId,
            });
          }
          return { runId: root.id, status: root.status };
        }),
      retry: (input) =>
        Effect.gen(function* () {
          const root = yield* findRootRunForOperation(input.runId, 'retry');
          if (root.status !== 'failed') {
            return yield* Effect.fail(
              new WorkflowEngineError({
                code: 'workflow_run_not_failed',
                message: `Workflow run ${root.id} is not failed.`,
                workflowRunId: root.id,
                surfaceId: root.surfaceId ?? undefined,
              }),
            );
          }
          const retried = yield* repository.retryFailedRun(root.id);
          if (!retried) {
            return yield* Effect.fail(
              new WorkflowEngineError({
                code: 'workflow_run_not_failed',
                message: `Workflow run ${root.id} is not failed.`,
                workflowRunId: root.id,
                surfaceId: root.surfaceId ?? undefined,
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

function normalizeWorktreePath(path: string) {
  return resolve(path);
}

function workflowLoadDiagnostic(error: unknown): WorkflowVerifyDiagnostic {
  if (error instanceof WorkflowLoadError) {
    return { stage: error.stage, message: error.message };
  }
  return { stage: 'resolve', message: errorMessage(error) };
}

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

function workflowRegistryContextForRun(
  run: WorkflowRunRow,
  workspaceRepository: WorkspaceRepositoryService,
): Effect.Effect<WorkflowRegistryContext, WorkflowEngineServiceError> {
  if (run.worktreeId === null) return Effect.succeed({});
  return workflowRegistryContextForWorktreeId(run.worktreeId, workspaceRepository);
}

function workflowRegistryContextForWorktreeId(
  worktreeId: number,
  workspaceRepository: WorkspaceRepositoryService,
): Effect.Effect<WorkflowRegistryContext, WorkflowEngineServiceError> {
  return Effect.gen(function* () {
    const worktree = yield* workspaceRepository.findWorktree(worktreeId);
    if (!worktree) {
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'worktree_not_found',
          message: `Worktree ${worktreeId} was not found.`,
          worktreeId,
        }),
      );
    }
    const project = yield* workspaceRepository.findProject(worktree.projectId);
    if (!project) {
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'workflow_load_failed',
          message: `Project ${worktree.projectId} for worktree ${worktree.id} was not found.`,
          worktreeId: worktree.id,
        }),
      );
    }
    return {
      projectId: project.id,
      projectRoot: project.rootPath,
    } satisfies WorkflowRegistryContext;
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
  if (condition.kind === 'agent_turn') {
    return `turn agentSessionId=${condition.agentSessionId} harnessSessionId=${condition.harnessSessionId}`;
  }
  if (condition.kind === 'headless_agent') {
    return `headless_agent ops=${condition.ops.map((op) => op.opId).join(',')}`;
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
