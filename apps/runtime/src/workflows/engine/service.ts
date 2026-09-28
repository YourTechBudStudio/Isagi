import { Cause, Context, Effect, FiberSet, Layer, type Scope } from 'effect';

import type {
  GetWorkflowExecutionOutput,
  GetWorkflowOperationOutput,
  GetWorkflowRunOutput,
  GetWorkflowStructureOutput,
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

import { HarnessAdapterRegistry } from '../../agent-sessions/harness/index.js';
import { AgentSessionArtifacts } from '../../agent-sessions/harness/ledger.js';
import { HarnessLedgerObserver } from '../../agent-sessions/harness/observer.service.js';
import { AgentSessionService } from '../../agent-sessions/index.js';
import { HarnessControlPlane } from '../../harness-control-plane/index.js';
import {
  RuntimeDatabase,
  type DatabaseError,
  type RuntimeDatabaseService,
} from '../../persistence/index.js';
import { PtyService } from '../../pty-processes/index.js';
import {
  InternalRuntimeEventBus,
  nextRuntimeEventEnvelope,
  RuntimeEventBus,
  type RuntimeEventBusService,
} from '../../runtime-events/index.js';
import { SurfaceRepository, SurfaceService } from '../../surfaces/index.js';
import { WorkspaceService } from '../../workspace/index.js';
import { WorkspaceRepository } from '../../workspace/workspace.repository.js';
import { WorkflowEngineError } from '../errors.js';
import { makeAgentPort } from '../operations/agents.js';
import { makeHeadlessPort, settleHeadless } from '../operations/headless.js';
import { eventDto, runSummaryById } from '../read/mappers.js';
import {
  getExecutionDetail,
  getOperationDetail,
  getRunDetail,
  getRunStructure,
  listAttachedSummaries,
  listRunEvents,
  listRunOperations,
  listRunSummaries,
} from '../read/reads.js';
import { errorMessage } from '../state/pure.js';
import { appendEvent } from '../store/events.js';
import { type Db, type EventRow } from '../store/rows.js';
import { getRun, listRunsWithStatus } from '../store/runs.js';
import { findLeafExecution } from '../store/tree.js';
import type { LoadedWorkflowArtifact } from '../structure/loader.js';
import { WorkflowRegistry } from '../structure/registry.js';
import { applyFailure } from './chain.js';
import * as controls from './controls.js';
import { driveRun } from './drive.js';
import {
  launch,
  listWorkflowDescriptors,
  type DescriptorListing,
  type LaunchInput,
} from './launch.js';
import { recoverAtStartup } from './restart.js';
import type { Emit, EngineDeps, EngineRuntime, HeadlessProcess } from './runtime.js';

/**
 * The workflow engine: launch, the controls, and the reads, behind one narrow surface.
 *
 * `startEngine` is the whole engine given its dependencies; the live layer only gathers the owning
 * services and hands them over, and tests hand over fakes instead.
 */
export interface WorkflowEngineService {
  readonly listWorkflowDescriptors: (
    origin: WorkflowLaunchOrigin,
  ) => Effect.Effect<readonly DescriptorListing[], unknown>;
  readonly launch: (
    input: LaunchInput,
  ) => Effect.Effect<{ readonly runId: number; readonly workflowKey: string }, unknown>;
  readonly pause: (runId: number) => Effect.Effect<WorkflowRunSummary, unknown>;
  readonly resume: (runId: number) => Effect.Effect<WorkflowRunSummary, unknown>;
  readonly retry: (runId: number) => Effect.Effect<WorkflowRunSummary, unknown>;
  readonly cancel: (runId: number) => Effect.Effect<WorkflowRunSummary, unknown>;
  readonly dismiss: (runId: number) => Effect.Effect<WorkflowRunSummary, unknown>;
  readonly advance: (input: {
    readonly runId: number;
    readonly executionId: number;
    readonly answers?: WorkflowUserInputAnswers | undefined;
  }) => Effect.Effect<WorkflowRunSummary, unknown>;
  readonly listRuns: (
    query: ListWorkflowRunsQuery,
  ) => Effect.Effect<ListWorkflowRunsOutput, unknown>;
  readonly listAttachedSummaries: Effect.Effect<readonly WorkflowRunSummary[], unknown>;
  readonly getRun: (runId: number) => Effect.Effect<GetWorkflowRunOutput, unknown>;
  readonly getStructure: (
    runId: number,
    artifactHash?: string | undefined,
  ) => Effect.Effect<GetWorkflowStructureOutput, unknown>;
  readonly listEvents: (
    runId: number,
    query: ListWorkflowEventsQuery,
  ) => Effect.Effect<ListWorkflowEventsOutput, unknown>;
  readonly listOperations: (
    runId: number,
    query: ListWorkflowOperationsQuery,
  ) => Effect.Effect<ListWorkflowOperationsOutput, unknown>;
  readonly getExecution: (
    executionId: number,
  ) => Effect.Effect<GetWorkflowExecutionOutput, unknown>;
  readonly getOperation: (
    operationId: number,
  ) => Effect.Effect<GetWorkflowOperationOutput, unknown>;
}

export const WorkflowEngine = Context.GenericTag<WorkflowEngineService>('isagi/WorkflowEngine');

/** The engine plus a way to wait until its background work has settled, for tests and scripts. */
export interface EngineHandle extends WorkflowEngineService {
  readonly awaitIdle: Effect.Effect<void>;
}

export const WorkflowEngineLive = Layer.scoped(
  WorkflowEngine,
  Effect.gen(function* () {
    const workspaceService = yield* WorkspaceService;
    const surfaces = yield* SurfaceService;
    const agents = yield* AgentSessionService;
    const artifacts = yield* AgentSessionArtifacts;
    const observer = yield* HarnessLedgerObserver;
    const pty = yield* PtyService;
    return yield* startEngine({
      database: yield* RuntimeDatabase,
      events: yield* RuntimeEventBus,
      deps: {
        registry: yield* WorkflowRegistry,
        places: {
          workspace: yield* WorkspaceRepository,
          workspaceService,
          surfaceRepository: yield* SurfaceRepository,
          surfaces,
        },
        agents: makeAgentPort({ agents, surfaces, pty, artifacts, observer }),
        headless: makeHeadlessPort({
          harnesses: yield* HarnessAdapterRegistry,
          controlPlane: yield* HarnessControlPlane,
          pty,
        }),
        internalEvents: yield* InternalRuntimeEventBus,
      },
    });
  }),
);

export function startEngine(input: {
  readonly database: RuntimeDatabaseService;
  readonly events: RuntimeEventBusService;
  readonly deps: EngineDeps;
}): Effect.Effect<EngineHandle, unknown, Scope.Scope> {
  return Effect.gen(function* () {
    const { database, events, deps } = input;
    const fibers = yield* FiberSet.make();
    const runtimeFiber = yield* FiberSet.runtime(fibers)<never>();
    let busy = 0;
    // Every background fiber counts as busy until it ends, so `awaitIdle` can tell when a run has
    // gone as far as it can.
    const runFiber = (work: Effect.Effect<void, never>) => {
      busy += 1;
      return runtimeFiber(work.pipe(Effect.ensuring(Effect.sync(() => (busy -= 1)))));
    };
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
      commit: <A>(operation: string, write: (db: Db, emit: Emit) => A) => {
        let appended: EventRow[] = [];
        return unwrapEngineError(
          database.transaction(operation, (db) => {
            appended = [];
            return write(db, (draft) => {
              appended.push(appendEvent(db, draft));
            });
          }),
        ).pipe(
          Effect.tap(() =>
            publish(appended).pipe(Effect.catchAllCause(logCause('publish failed'))),
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
        runFiber(
          Effect.gen(function* () {
            for (;;) {
              state.again = false;
              yield* driveRun(rt, runId).pipe(Effect.catchAllCause(failRunOnDefect(runId)));
              if (!state.again) break;
            }
          }).pipe(Effect.ensuring(Effect.sync(() => drivers.delete(runId)))),
        );
      },
      fork: (work, label) => {
        runFiber(work.pipe(Effect.catchAllCause(logCause(label))));
      },
      loadArtifact: (artifactHash, workflowKey) => {
        const cached = artifactCache.get(artifactHash);
        if (cached) return Effect.succeed(cached);
        return Effect.tap(deps.registry.loadPinned(artifactHash, workflowKey), (artifact) =>
          Effect.sync(() => artifactCache.set(artifactHash, artifact)),
        );
      },
      freshChecks: new Set(),
      headlessProcesses: new Map<number, HeadlessProcess>(),
    };

    /**
     * A defect inside a step is a runtime bug, not an author failure. The run fails with what is
     * known, so it is visible and retryable instead of silently stuck.
     */
    function failRunOnDefect(runId: number) {
      return (cause: Cause.Cause<unknown>) =>
        Effect.gen(function* () {
          console.error(
            '[runtime] Workflow step failed unexpectedly',
            { runId },
            Cause.pretty(cause),
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
            .pipe(Effect.catchAllCause(logCause('recording a step defect failed')));
        });
    }

    // Triggers: a turn edge may answer an agent wait; a PTY exit may settle a headless job.
    const subscription = yield* deps.internalEvents.subscribe({
      types: [
        'turn_started',
        'turn_ended',
        'turn_failed',
        'pty_process_exited',
        'pty_process_failed',
        'pty_process_killed',
      ],
    });
    yield* Effect.addFinalizer(() => subscription.unsubscribe);
    runtimeFiber(
      Effect.forever(
        Effect.gen(function* () {
          const event = yield* subscription.take;
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
          if (
            (event.type !== 'pty_process_exited' &&
              event.type !== 'pty_process_failed' &&
              event.type !== 'pty_process_killed') ||
            !rt.headlessProcesses.has(event.ptyProcessId)
          ) {
            return;
          }
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
            'workflow headless settlement',
          );
        }).pipe(Effect.catchAllCause(logCause('workflow trigger handling failed'))),
      ),
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
    const reading = <A>(operation: string, read: (db: Db) => A) =>
      unwrapEngineError(database.use(operation, read));

    const awaitIdle: Effect.Effect<void> = Effect.gen(function* () {
      // Two quiet ticks in a row: a fiber that just ended may have kicked another.
      let quiet = 0;
      while (quiet < 2) {
        yield* Effect.sleep('5 millis');
        quiet = busy === 0 ? quiet + 1 : 0;
      }
    });

    return {
      awaitIdle,
      listWorkflowDescriptors: (origin) => listWorkflowDescriptors(rt, origin),
      launch: (launchInput) => launch(rt, launchInput),
      pause: (runId) => Effect.zipRight(controls.pause(rt, runId), summaryOf(runId)),
      resume: (runId) => Effect.zipRight(controls.resume(rt, runId), summaryOf(runId)),
      retry: (runId) => Effect.zipRight(controls.retry(rt, runId), summaryOf(runId)),
      cancel: (runId) => Effect.zipRight(controls.cancel(rt, runId), summaryOf(runId)),
      dismiss: (runId) => Effect.zipRight(controls.dismiss(rt, runId), summaryOf(runId)),
      advance: (advanceInput) =>
        Effect.zipRight(controls.advance(rt, advanceInput), summaryOf(advanceInput.runId)),
      listRuns: (query) => reading('workflow_list_runs', (db) => listRunSummaries(db, query)),
      listAttachedSummaries: reading('workflow_list_attached', listAttachedSummaries),
      getRun: (runId) => reading('workflow_get_run', (db) => getRunDetail(db, runId)),
      getStructure: (runId, artifactHash) =>
        reading('workflow_get_structure', (db) => getRunStructure(db, runId, artifactHash)),
      listEvents: (runId, query) =>
        reading('workflow_list_events', (db) => listRunEvents(db, runId, query)),
      listOperations: (runId, query) =>
        reading('workflow_list_operations', (db) => listRunOperations(db, runId, query)),
      getExecution: (executionId) =>
        reading('workflow_get_execution', (db) => getExecutionDetail(db, executionId)),
      getOperation: (operationId) =>
        reading('workflow_get_operation', (db) => getOperationDetail(db, operationId)),
    } satisfies EngineHandle;
  });
}

/** A refusal thrown inside a transaction rolls it back and reports itself, not a database fault. */
function unwrapEngineError<A>(
  effect: Effect.Effect<A, DatabaseError>,
): Effect.Effect<A, DatabaseError | WorkflowEngineError> {
  return Effect.catchAll(effect, (error) =>
    Effect.fail(error.cause instanceof WorkflowEngineError ? error.cause : error),
  );
}

function logCause(label: string) {
  return (cause: Cause.Cause<unknown>) =>
    Effect.sync(() => {
      if (Cause.isInterruptedOnly(cause)) return;
      console.warn(`[runtime] ${label}`, Cause.pretty(cause));
    });
}
