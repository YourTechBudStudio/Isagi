import { Cause, Context, Effect, FiberMap, FiberSet, Layer, Stream, type Scope } from 'effect';

import type {
  ExportWorkflowCheckpointOutput,
  GetWorkflowCheckpointOutput,
  GetWorkflowExecutionOutput,
  GetWorkflowOperationOutput,
  GetWorkflowRunOutput,
  GetWorkflowStructureOutput,
  ListWorkflowCheckpointsOutput,
  ListWorkflowCheckpointsQuery,
  ListWorkflowEventsOutput,
  ListWorkflowEventsQuery,
  ListWorkflowOperationsOutput,
  ListWorkflowOperationsQuery,
  ListWorkflowRunsOutput,
  ListWorkflowRunsQuery,
  WorkflowLaunchOrigin,
  WorkflowRunSummary,
  WorkflowUserInputAnswers,
} from '@isagi/contracts';

import { AgentSessionService, SurfaceService } from '../../environment/index.js';
import {
  HarnessControlPlane,
  HarnessAdapterRegistry,
  AgentSessionArtifacts,
  HarnessLedgerObserver,
} from '../../harnesses/index.js';
import {
  InternalEvents,
  nextRuntimeEventEnvelope,
  RuntimeEvents,
} from '../../platform/events/index.js';
import { Git, type GitCommandError } from '../../platform/git/index.js';
import { RuntimeDatabase, type DatabaseError } from '../../platform/persistence/index.js';
import { ProjectRepository } from '../../projects/index.js';
import { PtyService } from '../../pty-processes/index.js';
import { WorkspaceService } from '../../workspace/index.js';
import { exportCheckpoint } from '../checkpoints/export.js';
import { openCheckpointFile, type CheckpointFileContent } from '../checkpoints/files.js';
import { makeCheckpointsPort } from '../checkpoints/port.js';
import { WorkflowEngineError } from '../errors.js';
import { makeAgentPort } from '../operations/agents.js';
import { makeHeadlessPort, settleHeadless } from '../operations/headless.js';
import { eventDto, runSummaryById } from '../read/mappers.js';
import {
  getCheckpointDetail,
  getExecutionDetail,
  getOperationDetail,
  getRunDetail,
  getRunStructure,
  listAttachedSummaries,
  listRunCheckpoints,
  listRunEvents,
  listRunOperations,
  listRunSummaries,
} from '../read/reads.js';
import { errorMessage } from '../state/pure.js';
import { WorkflowContentStore } from '../store/content-store.js';
import { appendEvent } from '../store/events.js';
import { type Db, type EventRow } from '../store/rows.js';
import { getRun, listRunsWithStatus } from '../store/runs.js';
import { findLeafExecution } from '../store/tree.js';
import type { LoadedWorkflowArtifact } from '../structure/loader.js';
import { WorkflowRegistry } from '../structure/registry.js';
import { makeAuthorBridge } from './author-bridge.js';
import { applyFailure } from './chain.js';
import * as controls from './controls.js';
import { driveRun } from './drive.js';
import type { PlacementInfrastructureError } from './environment/placement.js';
import {
  launch,
  listWorkflowDescriptors,
  type DescriptorListing,
  type LaunchInput,
} from './launch.js';
import { recoverAtStartup } from './restart.js';
import type { Abort, Emit, EngineDeps, EngineRuntime, HeadlessProcess } from './runtime.js';

/**
 * The engine plus what tests and scripts need to observe its background work: `inFlight` counts the
 * run drivers and forked steps still running, and `awaitIdle` waits until there are none.
 */
export interface EngineHandle extends WorkflowEngineShape {
  readonly inFlight: Effect.Effect<number>;
  readonly awaitIdle: Effect.Effect<void>;
}

/** What the engine's controls and reads can fail with: a refusal in the contract's reasons, or SQLite. */
export type WorkflowEngineFailure = WorkflowEngineError | DatabaseError;

const make = Effect.gen(function* () {
  const workspaceService = yield* WorkspaceService;
  const surfaces = yield* SurfaceService;
  const agents = yield* AgentSessionService;
  const artifacts = yield* AgentSessionArtifacts;
  const observer = yield* HarnessLedgerObserver;
  const pty = yield* PtyService;
  return yield* startEngine({
    database: yield* RuntimeDatabase,
    events: yield* RuntimeEvents,
    deps: {
      registry: yield* WorkflowRegistry,
      places: {
        workspace: yield* ProjectRepository,
        workspaceService,
        surfaceReads: surfaces,
        surfaces,
      },
      agents: makeAgentPort({ agents, surfaces, pty, artifacts, observer }),
      checkpoints: makeCheckpointsPort({
        git: yield* Git,
        content: yield* WorkflowContentStore,
        workspace: workspaceService,
      }),
      headless: makeHeadlessPort({
        harnesses: yield* HarnessAdapterRegistry,
        controlPlane: yield* HarnessControlPlane,
        pty,
      }),
      internalEvents: yield* InternalEvents,
    },
  });
});

interface WorkflowEngineShape {
  readonly listWorkflowDescriptors: (
    origin: WorkflowLaunchOrigin,
  ) => Effect.Effect<readonly DescriptorListing[], WorkflowEngineFailure>;
  /** Launch also calls the worktree preflight, whose own infrastructure failures pass through. */
  readonly launch: (
    input: LaunchInput,
  ) => Effect.Effect<
    { readonly runId: number; readonly workflowKey: string },
    WorkflowEngineError | PlacementInfrastructureError
  >;
  readonly pause: (runId: number) => Effect.Effect<WorkflowRunSummary, WorkflowEngineFailure>;
  readonly resume: (runId: number) => Effect.Effect<WorkflowRunSummary, WorkflowEngineFailure>;
  readonly retry: (runId: number) => Effect.Effect<WorkflowRunSummary, WorkflowEngineFailure>;
  readonly cancel: (runId: number) => Effect.Effect<WorkflowRunSummary, WorkflowEngineFailure>;
  readonly dismiss: (runId: number) => Effect.Effect<WorkflowRunSummary, WorkflowEngineFailure>;
  readonly advance: (input: {
    readonly runId: number;
    readonly executionId: number;
    readonly answers?: WorkflowUserInputAnswers | undefined;
  }) => Effect.Effect<WorkflowRunSummary, WorkflowEngineFailure>;
  readonly listRuns: (
    query: ListWorkflowRunsQuery,
  ) => Effect.Effect<ListWorkflowRunsOutput, DatabaseError>;
  readonly listAttachedSummaries: Effect.Effect<readonly WorkflowRunSummary[], DatabaseError>;
  readonly getRun: (runId: number) => Effect.Effect<GetWorkflowRunOutput, WorkflowEngineFailure>;
  readonly getStructure: (
    runId: number,
    artifactHash?: string | undefined,
  ) => Effect.Effect<GetWorkflowStructureOutput, WorkflowEngineFailure>;
  readonly listEvents: (
    runId: number,
    query: ListWorkflowEventsQuery,
  ) => Effect.Effect<ListWorkflowEventsOutput, WorkflowEngineFailure>;
  readonly listOperations: (
    runId: number,
    query: ListWorkflowOperationsQuery,
  ) => Effect.Effect<ListWorkflowOperationsOutput, WorkflowEngineFailure>;
  readonly getExecution: (
    executionId: number,
  ) => Effect.Effect<GetWorkflowExecutionOutput, WorkflowEngineFailure>;
  readonly getOperation: (
    operationId: number,
  ) => Effect.Effect<GetWorkflowOperationOutput, WorkflowEngineFailure>;
  readonly listCheckpoints: (
    runId: number,
    query: ListWorkflowCheckpointsQuery,
  ) => Effect.Effect<ListWorkflowCheckpointsOutput, WorkflowEngineFailure>;
  readonly getCheckpoint: (
    checkpointId: number,
  ) => Effect.Effect<GetWorkflowCheckpointOutput, WorkflowEngineFailure>;
  readonly openCheckpointFile: (
    checkpointId: number,
    path: string,
  ) => Effect.Effect<CheckpointFileContent, WorkflowEngineFailure>;
  /** Rebuilds a checkpoint in a new folder or detached worktree. See `checkpoints/export.ts`. */
  readonly exportCheckpoint: (
    checkpointId: number,
    destinationPath: string,
  ) => Effect.Effect<ExportWorkflowCheckpointOutput, WorkflowEngineFailure | GitCommandError>;
}

/**
 * The workflow engine: launch, the controls, and the reads, behind one narrow surface.
 *
 * `startEngine` is the whole engine given its dependencies; the live layer only gathers the owning
 * services and hands them over, and tests hand over fakes instead.
 */
export class WorkflowEngine extends Context.Service<WorkflowEngine, WorkflowEngineShape>()(
  'isagi/runtime/workflows/WorkflowEngine',
) {
  static readonly layerNoDeps = Layer.effect(WorkflowEngine, make);
  static readonly layer = WorkflowEngine.layerNoDeps.pipe(
    Layer.provide([
      AgentSessionArtifacts.layer,
      AgentSessionService.layer,
      Git.layer,
      HarnessAdapterRegistry.layer,
      HarnessControlPlane.layer,
      HarnessLedgerObserver.layer,
      InternalEvents.layer,
      ProjectRepository.layer,
      PtyService.layer,
      RuntimeEvents.layer,
      SurfaceService.layer,
      WorkflowContentStore.layer,
      WorkflowRegistry.layer,
      WorkspaceService.layer,
    ]),
  );
}

/**
 * The whole engine, given its dependencies: the test seam the live layer and the engine harness
 * share.
 *
 * Background work lives in fibers owned by the engine's scope:
 *
 * - `work`: run drivers (`kick`) and forked steps (`fork`). Its size is the engine's in-flight work;
 *   there is no hand-kept busy counter.
 * - the trigger loop: one scoped consumer of the internal event bus, outside `work`, because it
 *   never ends and is not work a caller waits for.
 * - `headlessTimers`: one pending timeout per headless job, removed (and so interrupted) when the
 *   job settles or is stopped.
 * - the author bridge's own fibers.
 *
 * Closing the scope interrupts all of them. An interrupted step is not a failure: nothing is
 * recorded, and startup on the next boot marks what was cut off (`restart.ts`).
 */
export function startEngine(input: {
  readonly database: RuntimeDatabase['Service'];
  readonly events: RuntimeEvents['Service'];
  readonly deps: EngineDeps;
}): Effect.Effect<EngineHandle, WorkflowEngineFailure, Scope.Scope> {
  return Effect.gen(function* () {
    const { database, events, deps } = input;
    // Made in this order so the scope closes them in reverse: the trigger loop, then run drivers
    // and forked steps, then headless timers, and only then calls bridged to author code. A driver
    // is therefore interrupted while it still awaits its node function, and never sees that
    // function's promise reject because its bridged call was cut off.
    const bridge = yield* makeAuthorBridge;
    const headlessTimers = yield* FiberMap.make<number>();
    const work = yield* FiberSet.make<void, never>();
    const runWork = yield* FiberSet.runtime(work)<never>();
    const artifactCache = new Map<string, LoadedWorkflowArtifact>();
    const drivers = new Map<number, { again: boolean }>();

    const publish = (rows: readonly EventRow[]) =>
      Effect.gen(function* () {
        for (const row of rows) {
          yield* events.publish({
            ...nextRuntimeEventEnvelope(),
            type: 'workflow_run_event',
            payload: eventDto(row),
          });
        }
        for (const runId of new Set(rows.map((row) => row.runId))) {
          const summary = yield* database.use('workflow_read_summary', (db) =>
            runSummaryById(db, runId),
          );
          if (summary) {
            yield* events.publish({
              ...nextRuntimeEventEnvelope(),
              type: 'workflow_run_changed',
              payload: summary,
            });
          }
        }
      });

    const rt: EngineRuntime = {
      deps,
      commit: <A>(operation: string, write: (db: Db, emit: Emit, abort: Abort) => A) => {
        let appended: EventRow[] = [];
        return database
          .transaction<A, WorkflowEngineError>(operation, (db, abort) => {
            appended = [];
            return write(
              db,
              (draft) => {
                appended.push(appendEvent(db, draft));
              },
              abort,
            );
          })
          .pipe(
            Effect.tap(() =>
              publish(appended).pipe(Effect.catchCause(logCause('Workflow event publish failed'))),
            ),
          );
      },
      read: (operation, read) => database.use(operation, read),
      kick: (runId) => {
        const driver = drivers.get(runId);
        if (driver) {
          driver.again = true;
          return;
        }
        const state = { again: false };
        drivers.set(runId, state);
        runWork(
          Effect.gen(function* () {
            for (;;) {
              state.again = false;
              yield* driveRun(rt, runId).pipe(Effect.catchCause(failRunOnDefect(runId)));
              if (!state.again) break;
            }
          }).pipe(
            Effect.ensuring(Effect.sync(() => drivers.delete(runId))),
            Effect.annotateLogs({ runId }),
          ),
        );
      },
      fork: (forked, label) => {
        runWork(forked.pipe(Effect.catchCause(logCause(label))));
      },
      loadArtifact: (artifactHash, workflowKey) => {
        const cached = artifactCache.get(artifactHash);
        if (cached) return Effect.succeed(cached);
        return Effect.tap(deps.registry.loadPinned(artifactHash, workflowKey), (artifact) =>
          Effect.sync(() => artifactCache.set(artifactHash, artifact)),
        );
      },
      bridge,
      headlessTimers,
      freshChecks: new Set(),
      headlessProcesses: new Map<number, HeadlessProcess>(),
      exportDestinations: new Set<string>(),
    };

    /**
     * A failure or defect inside a step is a runtime bug, not an author failure. The run fails with
     * what is known, so it is visible and retryable instead of silently stuck. An interruption (the
     * engine shutting down) is neither: the driver just stops.
     */
    function failRunOnDefect(runId: number) {
      return (cause: Cause.Cause<unknown>) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause as Cause.Cause<never>)
          : Effect.gen(function* () {
              yield* Effect.logError('Workflow step failed unexpectedly', cause).pipe(
                Effect.annotateLogs({ runId }),
              );
              const message = `Internal error: ${errorMessage(Cause.squash(cause))}`;
              yield* rt
                .commit('workflow_step_defect', (db, emit) => {
                  const run = getRun(db, runId);
                  if (!run || !['running', 'waiting'].includes(run.status)) return;
                  // The execution it was working on fails with it, so Retry repeats that one.
                  applyFailure(db, emit, run, findLeafExecution(db, runId), {
                    stage: 'node_function',
                    message,
                  });
                })
                .pipe(Effect.catchCause(logCause('Recording a workflow step defect failed')));
            });
    }

    // Triggers: a turn edge may answer an agent wait; a PTY exit may settle a headless job. The
    // subscription is taken here, before the consumer is forked, so no event published from now on
    // is missed.
    const triggers = yield* deps.internalEvents.subscribe([
      'turn_started',
      'turn_ended',
      'turn_failed',
      'pty_process_exited',
      'pty_process_failed',
      'pty_process_killed',
    ]);
    yield* triggers.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (
            event.type === 'turn_started' ||
            event.type === 'turn_ended' ||
            event.type === 'turn_failed'
          ) {
            const waiting = yield* database.use('workflow_waiting_runs', (db) =>
              listRunsWithStatus(db, ['waiting']),
            );
            for (const run of waiting) rt.kick(run.id);
            return;
          }
          if (!rt.headlessProcesses.has(event.ptyProcessId)) return;
          rt.fork(
            settleHeadless(rt, event.ptyProcessId, {
              status:
                event.type === 'pty_process_exited'
                  ? 'exited'
                  : event.type === 'pty_process_failed'
                    ? 'failed'
                    : 'killed',
              exitCode: event.type === 'pty_process_exited' ? event.exitCode : null,
            }),
            'Workflow headless settlement failed',
          );
        }).pipe(
          // One failed event must not end the trigger loop. An interruption-only cause still ends it.
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : logCause('Workflow trigger handling failed')(cause),
          ),
        ),
      ),
      Effect.forkScoped,
    );

    yield* recoverAtStartup(rt);

    const summaryOf = (runId: number) =>
      Effect.flatMap(
        database.use('workflow_read_summary', (db) => runSummaryById(db, runId)),
        (summary) =>
          summary
            ? Effect.succeed(summary)
            : Effect.fail(
                new WorkflowEngineError({
                  code: 'workflow_run_not_found',
                  message: `Workflow run ${runId} was not found.`,
                  workflowRunId: runId,
                }),
              ),
      );
    /** A read that may refuse (an unknown id): its own transaction, so `abort` is typed. */
    const reading = <A>(operation: string, read: (db: Db, abort: Abort) => A) =>
      database.transaction<A, WorkflowEngineError>(operation, read);

    const inFlight = FiberSet.size(work);
    const awaitIdle: Effect.Effect<void> = Effect.gen(function* () {
      // Two quiet checks in a row: a fiber that just ended may have kicked another, and a trigger
      // being handled may be about to.
      let quiet = 0;
      while (quiet < 2) {
        yield* FiberSet.awaitEmpty(work);
        yield* Effect.sleep('5 millis');
        quiet = (yield* inFlight) === 0 ? quiet + 1 : 0;
      }
    });

    return {
      inFlight,
      awaitIdle,
      listWorkflowDescriptors: Effect.fn('WorkflowEngine.listWorkflowDescriptors')(
        function* (origin) {
          return yield* listWorkflowDescriptors(rt, origin);
        },
      ),
      launch: Effect.fn('WorkflowEngine.launch')(function* (launchInput) {
        return yield* launch(rt, launchInput);
      }),
      pause: Effect.fn('WorkflowEngine.pause')(function* (runId) {
        yield* controls.pause(rt, runId);
        return yield* summaryOf(runId);
      }),
      resume: Effect.fn('WorkflowEngine.resume')(function* (runId) {
        yield* controls.resume(rt, runId);
        return yield* summaryOf(runId);
      }),
      retry: Effect.fn('WorkflowEngine.retry')(function* (runId) {
        yield* controls.retry(rt, runId);
        return yield* summaryOf(runId);
      }),
      cancel: Effect.fn('WorkflowEngine.cancel')(function* (runId) {
        yield* controls.cancel(rt, runId);
        return yield* summaryOf(runId);
      }),
      dismiss: Effect.fn('WorkflowEngine.dismiss')(function* (runId) {
        yield* controls.dismiss(rt, runId);
        return yield* summaryOf(runId);
      }),
      advance: Effect.fn('WorkflowEngine.advance')(function* (advanceInput) {
        yield* controls.advance(rt, advanceInput);
        return yield* summaryOf(advanceInput.runId);
      }),
      listRuns: Effect.fn('WorkflowEngine.listRuns')(function* (query) {
        return yield* database.use('workflow_list_runs', (db) => listRunSummaries(db, query));
      }),
      listAttachedSummaries: database
        .use('workflow_list_attached', listAttachedSummaries)
        .pipe(Effect.withSpan('WorkflowEngine.listAttachedSummaries')),
      getRun: Effect.fn('WorkflowEngine.getRun')(function* (runId) {
        return yield* reading('workflow_get_run', (db, abort) => getRunDetail(db, runId, abort));
      }),
      getStructure: Effect.fn('WorkflowEngine.getStructure')(function* (runId, artifactHash) {
        return yield* reading('workflow_get_structure', (db, abort) =>
          getRunStructure(db, runId, artifactHash, abort),
        );
      }),
      listEvents: Effect.fn('WorkflowEngine.listEvents')(function* (runId, query) {
        return yield* reading('workflow_list_events', (db, abort) =>
          listRunEvents(db, runId, query, abort),
        );
      }),
      listOperations: Effect.fn('WorkflowEngine.listOperations')(function* (runId, query) {
        return yield* reading('workflow_list_operations', (db, abort) =>
          listRunOperations(db, runId, query, abort),
        );
      }),
      getExecution: Effect.fn('WorkflowEngine.getExecution')(function* (executionId) {
        return yield* reading('workflow_get_execution', (db, abort) =>
          getExecutionDetail(db, executionId, abort),
        );
      }),
      getOperation: Effect.fn('WorkflowEngine.getOperation')(function* (operationId) {
        return yield* reading('workflow_get_operation', (db, abort) =>
          getOperationDetail(db, operationId, abort),
        );
      }),
      listCheckpoints: Effect.fn('WorkflowEngine.listCheckpoints')(function* (runId, query) {
        return yield* reading('workflow_list_checkpoints', (db, abort) =>
          listRunCheckpoints(db, runId, query, abort),
        );
      }),
      getCheckpoint: Effect.fn('WorkflowEngine.getCheckpoint')(function* (checkpointId) {
        return yield* reading('workflow_get_checkpoint', (db, abort) =>
          getCheckpointDetail(db, checkpointId, abort),
        );
      }),
      openCheckpointFile: Effect.fn('WorkflowEngine.openCheckpointFile')(
        function* (checkpointId, path) {
          return yield* openCheckpointFile(rt, checkpointId, path);
        },
      ),
      exportCheckpoint: Effect.fn('WorkflowEngine.exportCheckpoint')(
        function* (checkpointId, destinationPath) {
          return yield* exportCheckpoint(rt, checkpointId, destinationPath);
        },
      ),
    } satisfies EngineHandle;
  });
}

/** Logs a background failure at Warning; an interruption-only cause is the engine stopping, not news. */
function logCause(label: string) {
  return (cause: Cause.Cause<unknown>) =>
    Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logWarning(label, cause);
}
