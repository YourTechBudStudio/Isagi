import { randomUUID } from 'node:crypto';

import type { OperationContext } from '@yourtechbudstudio/isagi-workflow-sdk';
import { Context, Effect, Layer } from 'effect';

import { HarnessAdapterRegistry } from '../../agent-sessions/harness/index.js';
import { HarnessLedgerObserver } from '../../agent-sessions/harness/observer.service.js';
import { AgentSessionArtifacts, AgentSessionService } from '../../agent-sessions/index.js';
import { HarnessControlPlane } from '../../harness-control-plane/index.js';
import { RuntimeIdentity } from '../../persistence/index.js';
import { PtyService } from '../../pty-processes/index.js';
import {
  InternalRuntimeEventBus,
  type InternalRuntimeEventBusService,
} from '../../runtime-events/internal-event-bus.js';
import { SurfaceService } from '../../surfaces/index.js';
import {
  WorkflowOperationsRepository,
  type WorkflowOperationsRepositoryService,
} from '../persistence/operations.repository.js';
import {
  WorkflowPayloadStore,
  type WorkflowPayloadStoreService,
} from '../persistence/payload-store.js';
import {
  WorkflowRunsRepository,
  type WorkflowRunsRepositoryService,
} from '../persistence/runs.repository.js';
import { makeAgentSessionAdapter } from './adapters/agent-session.js';
import { makeHeadlessAdapter } from './adapters/headless.js';
import { makePaneAdapter } from './adapters/pane.js';
import type { OperationAdapters } from './adapters/types.js';
import {
  makeAttemptContextFactory,
  type AttemptContextOutcome,
  type OperationAttemptIdentity,
} from './attempt-context.js';
import { makeCaptureRegistry } from './capture.js';
import {
  makeOperationReconciler,
  type ExecutionReconciliation,
  type OperationReconciler,
} from './reconcile.js';
import { makeOperationSettlement } from './settlement.js';
import { makeOperationStopPolicy, type StopSummary } from './stop.js';

export { defaultHeadlessTimeoutMs } from './attempt-context.js';
export type { AttemptContextOutcome, OperationAttemptIdentity } from './attempt-context.js';
export type { ExecutionReconciliation } from './reconcile.js';
export type { StopSummary } from './stop.js';

export interface WorkflowOperationServiceShape {
  /** Identifies this runtime process as the owner of every capture it starts. */
  readonly incarnationId: string;
  /**
   * Run a callback with a live `ctx`, and close the verbs behind it.
   *
   * The context's scope belongs to the invocation, so a verb reached from a promise the callback
   * never awaited fails rather than acting on a segment that has already committed. Headless capture
   * deliberately does **not** live in this scope: a submitted operation is the runtime's to finish
   * observing whether or not the callback that launched it is still running.
   */
  readonly withAttemptContext: <A, E, R>(
    identity: OperationAttemptIdentity,
    use: (context: OperationContext) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<AttemptContextOutcome<A>, E, R>;
  /** Settle what can be settled before a callback is re-entered. Blocks the run on uncertainty. */
  readonly reconcileExecution: (
    executionId: number,
  ) => Effect.Effect<ExecutionReconciliation, never>;
  /** The same, across every unsettled operation this process did not start. */
  readonly reconcileAtStartup: Effect.Effect<readonly ExecutionReconciliation[], never>;
  /**
   * Settle a submission from the turn its wait observed.
   *
   * The wait resolver owns turn observation and this layer owns every operation write, so the
   * resolver reports what it saw rather than writing the row itself.
   */
  readonly recordTurnObservation: OperationReconciler['recordTurnObservation'];
  /** Freeze a submission's turn association the first time it can be established. */
  readonly fixTurnAssociation: OperationReconciler['fixTurnAssociation'];
  readonly stopOwnedOperations: (input: {
    readonly runId: number;
    readonly reason: string;
  }) => Effect.Effect<StopSummary, never>;
}

export const WorkflowOperationService = Context.GenericTag<WorkflowOperationServiceShape>(
  'isagi/WorkflowOperationService',
);

export interface OperationServiceDependencies {
  readonly operations: WorkflowOperationsRepositoryService;
  readonly runs: WorkflowRunsRepositoryService;
  readonly payloads: WorkflowPayloadStoreService;
  readonly adapters: OperationAdapters;
  readonly eventBus: InternalRuntimeEventBusService;
  readonly now?: (() => string) | undefined;
  readonly incarnationId?: string | undefined;
  /**
   * This runtime's durable identity, stamped on every operation row.
   *
   * Required, with no default — unlike `incarnationId`, which may legitimately be minted per
   * process because a fresh process *is* a fresh incarnation. A fresh runtime id would instead be a
   * fabricated identity indistinguishable from a real one, and would break the reading the column
   * exists for: two `runtime_id` values in one database always mean two runtimes.
   */
  readonly runtimeId: string;
}

export function makeWorkflowOperationService(
  dependencies: OperationServiceDependencies,
): Effect.Effect<WorkflowOperationServiceShape, never, import('effect').Scope.Scope> {
  return Effect.gen(function* () {
    const { operations, runs, payloads, adapters, eventBus } = dependencies;
    // The scope this service was built in. Everything it owns beyond a single callback — result
    // capture, timeouts, the PTY-terminal subscriber — is forked into it, so "the incarnation ended"
    // is a single structural fact rather than several bookkeeping ones.
    const incarnationScope = yield* Effect.scope;
    const now = dependencies.now ?? (() => new Date().toISOString());
    // A fresh process has a fresh id, so "the incarnation that owned this operation's capture has
    // ended" is established by a positive stored fact rather than by an empty in-memory map.
    const incarnationId = dependencies.incarnationId ?? randomUUID();

    const settlement = makeOperationSettlement({ operations, payloads, eventBus });
    const stop = makeOperationStopPolicy({ operations, adapters });
    const captures = makeCaptureRegistry({
      operations,
      adapters,
      settlement,
      stop,
      incarnationScope,
    });
    const reconciler = makeOperationReconciler({
      operations,
      runs,
      adapters,
      settlement,
      stop,
      incarnationId,
    });

    const withAttemptContext = makeAttemptContextFactory({
      operations,
      adapters,
      settlement,
      reconciler,
      captures,
      runs,
      stop,
      incarnationId,
      runtimeId: dependencies.runtimeId,
      now,
    });

    const service: WorkflowOperationServiceShape = {
      incarnationId,
      withAttemptContext,
      reconcileExecution: reconciler.reconcileExecution,
      reconcileAtStartup: reconciler.reconcileAtStartup,
      recordTurnObservation: reconciler.recordTurnObservation,
      fixTurnAssociation: reconciler.fixTurnAssociation,
      stopOwnedOperations: stop.stopOwnedOperations,
    };

    // Process terminals are the ordinary completion path for a headless operation this incarnation
    // owns. Persistence happens before the notification, so a subscriber can never observe a
    // completion whose row has not been written.
    const subscription = yield* eventBus.subscribe({
      types: ['pty_process_exited', 'pty_process_failed', 'pty_process_killed'],
    });
    yield* Effect.addFinalizer(() => subscription.unsubscribe);
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const event = yield* subscription.take;
          if (
            event.type !== 'pty_process_exited' &&
            event.type !== 'pty_process_failed' &&
            event.type !== 'pty_process_killed'
          ) {
            return;
          }
          yield* captures.onProcessTerminal({
            ptyProcessId: event.ptyProcessId,
            terminal:
              event.type === 'pty_process_exited'
                ? { kind: 'exited', exitCode: event.exitCode }
                : event.type === 'pty_process_failed'
                  ? { kind: 'failed' }
                  : { kind: 'killed' },
          });
        }).pipe(
          Effect.catchAllCause((cause) =>
            Effect.sync(() => {
              console.warn('[runtime] Workflow operation PTY event handling failed', cause);
            }),
          ),
        ),
      ),
    );

    yield* Effect.addFinalizer(() => captures.clear);

    return service;
  });
}

export const WorkflowOperationServiceLive = Layer.scoped(
  WorkflowOperationService,
  Effect.gen(function* () {
    const operations = yield* WorkflowOperationsRepository;
    const runs = yield* WorkflowRunsRepository;
    const payloads = yield* WorkflowPayloadStore;
    const eventBus = yield* InternalRuntimeEventBus;
    const agents = yield* AgentSessionService;
    const surfaces = yield* SurfaceService;
    const pty = yield* PtyService;
    const artifacts = yield* AgentSessionArtifacts;
    const observer = yield* HarnessLedgerObserver;
    const harnesses = yield* HarnessAdapterRegistry;
    const controlPlane = yield* HarnessControlPlane;
    const identity = yield* RuntimeIdentity;
    return yield* makeWorkflowOperationService({
      operations,
      runs,
      payloads,
      eventBus,
      runtimeId: identity.runtimeId,
      adapters: {
        agentSessions: makeAgentSessionAdapter({ agents, surfaces, pty, artifacts, observer }),
        panes: makePaneAdapter(surfaces),
        headless: makeHeadlessAdapter({ harnesses, pty, controlPlane }),
      },
    });
  }),
);
