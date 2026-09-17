import { Context, Effect, Fiber, Layer, Queue } from 'effect';

import type { WorkflowLaunchOrigin, WorkflowPlacementRequestDto } from '@isagi/contracts';

import { HarnessLedgerObserver } from '../../agent-sessions/harness/observer.service.js';
import type { DatabaseError } from '../../persistence/index.js';
import { InternalRuntimeEventBus } from '../../runtime-events/internal-event-bus.js';
import { SurfaceRepository, SurfaceService } from '../../surfaces/index.js';
import { WorkspaceService } from '../../workspace/index.js';
import { WorkspaceRepository } from '../../workspace/index.js';
import { WorkflowOperationService } from '../operations/operation.service.js';
import { WorkflowOperationsRepository } from '../persistence/operations.repository.js';
import { WorkflowPayloadStore, type PayloadPublishError } from '../persistence/payload-store.js';
import type { WorkflowRunRecord } from '../persistence/records.js';
import { WorkflowRunsRepository } from '../persistence/runs.repository.js';
import { WorkflowArtifactCatalog } from '../structure/artifact-catalog.js';
import { WorkflowRegistry } from '../structure/registry.js';
import type { WorkflowEngineError } from '../types.js';
import { startEnvironmentWatch } from '../waits/environment.js';
import { makeWaitResolver, startWaitResolver } from '../waits/resolver.js';
import { makeControls, type ControlResult } from './controls.js';
import { makeDispatcher, type DrainSummary } from './dispatcher.js';
import type { PlacementInfrastructureError } from './environment/placement.js';
import { prepareEnvironment } from './environment/preparation.js';
import type { PreparationContext, PreparationDeps } from './environment/types.js';
import { listWorkflowDescriptors, startWorkflow, type DescriptorListing } from './launch.js';
import { recoverAtStartup } from './recovery.js';

/**
 * The workflow domain's one operational entry point.
 *
 * Deliberately narrow: launching, the six controls, and the two dispatcher affordances a caller
 * needs. Everything behind it — the segment handlers, the wait resolver, the environment watch, the
 * startup recovery — is internal, and none of it is reachable except through a run id.
 */
export interface WorkflowEngineService {
  readonly listWorkflowDescriptors: (input: {
    readonly origin: WorkflowLaunchOrigin;
  }) => Effect.Effect<readonly DescriptorListing[], WorkflowEngineError>;
  readonly startWorkflow: (input: {
    readonly workflowKey: string;
    readonly inputs?: Record<string, unknown> | undefined;
    readonly origin: WorkflowLaunchOrigin;
    /** A caller's explicit destination. It beats the workflow's `environment` hook and the default. */
    readonly placement?: WorkflowPlacementRequestDto | undefined;
  }) => Effect.Effect<WorkflowRunRecord, EngineFailure>;
  readonly pause: (input: {
    readonly runId: number;
  }) => Effect.Effect<ControlResult, EngineFailure>;
  readonly resume: (input: {
    readonly runId: number;
  }) => Effect.Effect<ControlResult, EngineFailure>;
  readonly retry: (input: {
    readonly runId: number;
  }) => Effect.Effect<ControlResult, EngineFailure>;
  readonly cancel: (input: {
    readonly runId: number;
  }) => Effect.Effect<ControlResult, EngineFailure>;
  readonly dismiss: (input: {
    readonly runId: number;
  }) => Effect.Effect<ControlResult, EngineFailure>;
  readonly advance: (input: {
    readonly runId: number;
    readonly waitId: number;
    readonly answers?: Record<string, unknown> | undefined;
  }) => Effect.Effect<ControlResult, EngineFailure>;
  /** Advance every dispatchable run until none moves. Exposed for tests and for startup. */
  readonly drainOnce: Effect.Effect<DrainSummary, DatabaseError | PayloadPublishError>;
  /** Wake the worker. A hint: it drains from durable state, never from what the hint said. */
  readonly poke: Effect.Effect<void>;
}

/**
 * What a control or a launch can fail with.
 *
 * `PlacementInfrastructureError` is here because the launch path makes one owning-service call — the
 * worktree creation preflight — and Git, the state file and project configuration can fail
 * underneath it. Those are infrastructure, not a placement the person chose badly, so they cross
 * this boundary as themselves and `workflows/api.ts` reports each one the way the workspace boundary
 * already reports it.
 */
export type EngineFailure =
  | WorkflowEngineError
  | DatabaseError
  | PayloadPublishError
  | PlacementInfrastructureError;

export const WorkflowEngine = Context.GenericTag<WorkflowEngineService>('isagi/WorkflowEngine');

export const WorkflowEngineLive = Layer.scoped(
  WorkflowEngine,
  Effect.gen(function* () {
    const runs = yield* WorkflowRunsRepository;
    const operationRecords = yield* WorkflowOperationsRepository;
    const payloads = yield* WorkflowPayloadStore;
    const catalog = yield* WorkflowArtifactCatalog;
    const registry = yield* WorkflowRegistry;
    const workspace = yield* WorkspaceRepository;
    const workspaceService = yield* WorkspaceService;
    const surfaces = yield* SurfaceService;
    const surfaceRepository = yield* SurfaceRepository;
    const operations = yield* WorkflowOperationService;
    const eventBus = yield* InternalRuntimeEventBus;
    const observer = yield* HarnessLedgerObserver;

    // One worker, woken through a sliding queue of size one: several wake-ups while a drain is in
    // flight collapse into one more drain, which is all they ever mean.
    const wakeQueue = yield* Queue.sliding<void>(1);
    const poke = wakeQueue.offer(void 0).pipe(Effect.asVoid);
    const owner = `workflow-engine:${process.pid}:${Date.now()}`;

    const waits = makeWaitResolver({
      runs,
      payloads,
      operationRecords,
      operations,
      catalog,
      turnEdges: (agentSessionId) => observer.getTurnEdges(agentSessionId),
    });

    const dispatcher = makeDispatcher({
      runs,
      payloads,
      operations,
      operationRecords,
      catalog,
      owner,
      // The incarnation the operation service owns, shared rather than reinvented: it is what
      // "this process started that capture" means, and two different values would make a capture
      // this process owns look abandoned.
      ownerIncarnation: operations.incarnationId,
      reconcileExecution: operations.reconcileExecution,
      reconcileWait: waits.reconcileWait,
    });

    // The layer's own scope, captured so preparation can be forked into it rather than into the
    // request fiber. See `runPreparation` below for why that distinction is the whole point.
    const engineScope = yield* Effect.scope;

    const launchDeps = {
      runs,
      registry,
      catalog,
      workspace,
      workspaceService,
      surfaces,
      surfaceRepository,
      owner,
      // The same incarnation the dispatcher and the operation service use: "this process started
      // that work" has to mean one thing, or a claim this process holds looks abandoned to it.
      ownerIncarnation: operations.incarnationId,
    };
    const prepDeps: PreparationDeps = {
      runs,
      workspace,
      workspaceService,
      surfaceRepository,
      surfaces,
      owner,
      ownerIncarnation: operations.incarnationId,
      poke,
    };

    /**
     * Preparation, forked into the engine's scope and then awaited.
     *
     * Forking rather than running inline is what stops a dropped client connection from
     * interrupting `git worktree add` or a setup hook half way: the request fiber may be
     * interrupted, but the work belongs to the engine, which outlives any one request. The join is
     * what makes the launch request block until the environment exists, which is the behaviour the
     * palette already has for `openWorktree`.
     *
     * The fiber is deliberately **interruptible**, the same posture as the dispatcher worker.
     * Runtime shutdown closes this scope and interrupts it, and the residue that leaves — a
     * checkout with no receipt — is exactly what the adoption predicate and startup recovery exist
     * to handle. Nothing here is wrapped in `Effect.uninterruptible`: an uninterruptible hook could
     * hold shutdown for its entire timeout.
     */
    const runPreparation = (ctx: PreparationContext) =>
      Effect.forkIn(prepareEnvironment(prepDeps, ctx), engineScope).pipe(
        Effect.flatMap(Fiber.join),
      );

    const controls = makeControls({
      ...launchDeps,
      payloads,
      operationRecords,
      operations,
      waits,
      poke,
    });

    const service: WorkflowEngineService = {
      listWorkflowDescriptors: (input) => listWorkflowDescriptors(launchDeps, input.origin),
      startWorkflow: (input) =>
        startWorkflow(launchDeps, {
          workflowKey: input.workflowKey,
          inputs: input.inputs ?? {},
          origin: input.origin,
          ...(input.placement === undefined ? {} : { placement: input.placement }),
        }).pipe(
          // The launch request blocks until preparation completes. Forking into the engine scope is
          // what stops a dropped client from interrupting Git half way; the trailing `poke` moved
          // inside preparation, which is now the only thing that knows when a run is dispatchable.
          Effect.tap(runPreparation),
          Effect.map(({ run }) => run),
        ),
      pause: (input) => controls.pause(input.runId),
      resume: (input) => controls.resume(input.runId),
      retry: (input) => controls.retry(input.runId),
      cancel: (input) => controls.cancel(input.runId),
      dismiss: (input) => controls.dismiss(input.runId),
      advance: (input) => controls.advance(input),
      drainOnce: dispatcher.drainOnce,
      poke,
    };

    // Startup ordering, and it is not incidental: every unfinished run is parked and every recorded
    // operation settled *before* the first drain, so the worker never dispatches into a run whose
    // external effects nobody has accounted for yet.
    const recovery = yield* recoverAtStartup({
      runs,
      workspace,
      surfaces: surfaceRepository,
      eventBus,
      operations,
      waits,
    });
    if (recovery.parked > 0 || recovery.environmentsLost > 0) {
      yield* Effect.logInfo('[runtime] Workflow startup recovery complete', recovery);
    }

    yield* startWaitResolver({ resolver: waits, eventBus, poke });
    yield* startEnvironmentWatch({ runs, workspace, surfaces: surfaceRepository, eventBus });

    // A drain that yielded with work still available wakes the worker again, so the pass limit
    // bounds how long one run holds the worker without ever stranding the rest.
    const drainAndRequeue = dispatcher.drainOnce.pipe(
      Effect.flatMap((summary) => (summary.exhausted ? poke : Effect.void)),
    );
    yield* drainAndRequeue.pipe(Effect.catchAllCause(logDrainFailure('startup drain')));
    yield* Effect.forkScoped(
      Effect.forever(
        wakeQueue.take.pipe(
          Effect.zipRight(drainAndRequeue),
          Effect.catchAllCause(logDrainFailure('wake drain')),
        ),
      ),
    );

    return service;
  }),
);

function logDrainFailure(label: string) {
  return (cause: unknown) =>
    Effect.sync(() => {
      console.error(`[runtime] Workflow dispatcher failed during ${label}`, cause);
    });
}
