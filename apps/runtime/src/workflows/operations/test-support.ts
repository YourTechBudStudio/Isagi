import { join } from 'node:path';

import type {
  WorkflowAgentHarness,
  WorkflowConversationMessage,
} from '@yourtechbudstudio/isagi-workflow-sdk';
import BetterSqlite from 'better-sqlite3';
import { Cause, Context, Effect, Exit, Layer, Option, Scope } from 'effect';

import type { WorkflowOperationStage } from '@isagi/contracts';

import { DatabaseError } from '../../persistence/index.js';
import type { PtyTerminateOutcome } from '../../pty-processes/index.js';
import type { PtyProcessAllocation, PtyProcessLaunchMetadata } from '../../pty-processes/types.js';
import {
  InternalRuntimeEventBus,
  InternalRuntimeEventBusLive,
  type InternalRuntimeEvent,
  type InternalRuntimeEventBusService,
} from '../../runtime-events/internal-event-bus.js';
import type { WorkflowOperationsRepositoryService } from '../persistence/operations.repository.js';
import {
  makeWorkflowPersistenceFixture,
  prepareClaim,
  run,
  type WorkflowPersistenceFixture,
} from '../persistence/test-support.js';
import type { WorkflowObservedTurnEdge } from '../waits/conditions.js';
import type {
  AgentSessionOperationAdapter,
  HeadlessOperationAdapter,
  OperationAdapters,
  PaneOperationAdapter,
} from './adapters/types.js';
import {
  makeWorkflowOperationService,
  type OperationAttemptIdentity,
  type WorkflowOperationServiceShape,
} from './operation.service.js';

export const PIN = 'a'.repeat(64);
const OWNER = 'worker-1';
const OWNER_INCARNATION = 'incarnation-1';

/**
 * What each fake adapter actually did.
 *
 * Counts rather than "eventually completed", because every rule in this phase is about how many
 * times an effect crossed a boundary. A test that only asserts a run finished cannot tell a reused
 * receipt from a second dispatch into the person's worktree.
 */
export interface DispatchCounters {
  sendPrepares: number;
  spawnCreate: number;
  seedPrepare: number;
  promptWrites: number;
  seedAcknowledgements: number;
  paneCloses: number;
  allocations: number;
  starts: number;
  terminations: number;
}

export type FakeLaunchOutcome =
  | { readonly kind: 'spawned' }
  | { readonly kind: 'preparation_failed'; readonly cause: string }
  /** The decisive case: the backend spawned and something *after* it threw, so a process may live. */
  | { readonly kind: 'spawn_failed'; readonly cause: string }
  /** `start` never returns: the reservation is released and the stage stays `starting`. */
  | { readonly kind: 'interrupted' }
  /** `start` hangs until something interrupts it, so cleanup on interruption is observable. */
  | { readonly kind: 'hang' };

export interface FakeAdapterState {
  readonly counters: DispatchCounters;
  /** Consumed in order; the last entry repeats once exhausted. */
  launchOutcomes: FakeLaunchOutcome[];
  turnEdges: Map<number, WorkflowObservedTurnEdge[]>;
  sessionHarness: WorkflowAgentHarness;
  capturedOutput: Map<number, { raw: string; output: string }>;
  terminateOutcome: (ptyProcessId: number) => PtyTerminateOutcome | Error;
  /** Rejections injected into an owner call, by name, to drive live failure paths. */
  failures: Map<string, Error>;
  /**
   * Owner calls that never return, by name.
   *
   * `Effect.never` rather than a long sleep: interruption is the thing under test, and a sleep would
   * let a test pass by outlasting it instead of by being interrupted.
   */
  hangs: Set<string>;
  /**
   * Owner calls held open until the test releases them.
   *
   * Unlike `hangs`, these finish. They exist to put a test *inside* an owner call — where the real
   * cost is: waiting for an observer, for quiescence, for a process to come up — so a control can be
   * applied mid-flight and the code after the wait is what gets exercised.
   */
  gates: Map<string, Promise<void>>;
  /** Makes the PTY write take observable time, so an interrupt can be aimed at that window. */
  submitDelayMs: number;
  nextPtyProcessId: number;
  nextAgentSessionId: number;
  nextPaneId: number;
  quiescenceBusy: boolean;
  controlPlaneBlocked: Error | null;
  /** Records every `abandon`, so a released reservation is provable rather than assumed. */
  abandoned: number[];
  /**
   * Panes the owner actually removed.
   *
   * A set rather than a counter, because the question a repeated close has to answer is whether the
   * *resource* changed twice, not whether the call happened twice. An idempotent owner is allowed to
   * be called again; it is not allowed to remove a second pane.
   */
  closedPanes: Set<number>;
}

export function makeFakeAdapterState(): FakeAdapterState {
  return {
    counters: {
      sendPrepares: 0,
      spawnCreate: 0,
      seedPrepare: 0,
      promptWrites: 0,
      seedAcknowledgements: 0,
      paneCloses: 0,
      allocations: 0,
      starts: 0,
      terminations: 0,
    },
    launchOutcomes: [{ kind: 'spawned' }],
    turnEdges: new Map(),
    sessionHarness: 'claude',
    capturedOutput: new Map(),
    terminateOutcome: () => 'terminated_live',
    failures: new Map(),
    hangs: new Set(),
    gates: new Map<string, Promise<void>>(),
    submitDelayMs: 0,
    nextPtyProcessId: 900,
    nextAgentSessionId: 500,
    nextPaneId: 700,
    quiescenceBusy: false,
    controlPlaneBlocked: null,
    abandoned: [],
    closedPanes: new Set<number>(),
  };
}

function failIfConfigured(state: FakeAdapterState, name: string) {
  const failure = state.failures.get(name);
  if (failure) return Effect.fail(failure);
  return state.hangs.has(name) ? (Effect.never as Effect.Effect<void>) : Effect.void;
}

/**
 * Hold inside an owner call until the test releases it.
 *
 * Applied *after* the call's own counter so a test can wait for the call to be entered and then act
 * — which is the whole point, since the window under test is the one inside the owner call rather
 * than before it.
 */
function gateFor(state: FakeAdapterState, name: string) {
  const gate = state.gates.get(name);
  return gate ? Effect.promise(() => gate) : Effect.void;
}

export function makeFakeAdapters(state: FakeAdapterState): OperationAdapters {
  const agentSessions: AgentSessionOperationAdapter = {
    prepareSend: (input) =>
      Effect.gen(function* () {
        yield* failIfConfigured(state, 'prepareSend');
        state.counters.sendPrepares += 1;
        yield* gateFor(state, 'prepareSend');
        if (state.quiescenceBusy) {
          return yield* Effect.fail(
            new Error(
              `Cannot send an agent prompt into session ${input.agentSessionId}: a turn is already in flight.`,
            ),
          );
        }
        return { agentSessionId: input.agentSessionId, ptyProcessId: state.nextPtyProcessId };
      }),
    createKeyedSession: (input) =>
      Effect.gen(function* () {
        yield* failIfConfigured(state, 'createKeyedSession');
        state.counters.spawnCreate += 1;
        yield* gateFor(state, 'createKeyedSession');
        // Keyed by the operation key, exactly as the real owner is: re-entry under the same key
        // resolves to the same compound rather than creating a second one.
        const existing = keyedSessions.get(input.creationKey);
        if (existing) return existing;
        const created = {
          surfaceId: input.surfaceId,
          paneId: state.nextPaneId++,
          agentSessionId: state.nextAgentSessionId++,
        };
        keyedSessions.set(input.creationKey, created);
        return created;
      }),
    prepareSeed: (input) =>
      Effect.gen(function* () {
        yield* failIfConfigured(state, 'prepareSeed');
        state.counters.seedPrepare += 1;
        yield* gateFor(state, 'prepareSeed');
        return { agentSessionId: input.agentSessionId, ptyProcessId: state.nextPtyProcessId };
      }),
    submitPrompt: () =>
      Effect.gen(function* () {
        yield* failIfConfigured(state, 'submitPrompt');
        if (state.submitDelayMs > 0) yield* Effect.sleep(`${state.submitDelayMs} millis`);
        state.counters.promptWrites += 1;
      }),
    awaitSeedAcknowledgement: () =>
      Effect.gen(function* () {
        yield* failIfConfigured(state, 'awaitSeedAcknowledgement');
        state.counters.seedAcknowledgements += 1;
        return 'harness-session-1';
      }),
    sessionHarness: () => Effect.succeed(state.sessionHarness),
    turnEdges: (agentSessionId) =>
      Effect.gen(function* () {
        yield* failIfConfigured(state, 'turnEdges');
        return (state.turnEdges.get(agentSessionId) ?? []) as readonly WorkflowObservedTurnEdge[];
      }),
    conversationHistory: () =>
      Effect.gen(function* () {
        yield* failIfConfigured(state, 'conversationHistory');
        return [] as readonly WorkflowConversationMessage[];
      }),
  };
  const keyedSessions = new Map<
    string,
    { surfaceId: number; paneId: number; agentSessionId: number }
  >();

  const panes: PaneOperationAdapter = {
    closePane: (input) =>
      Effect.gen(function* () {
        yield* failIfConfigured(state, 'closePane');
        // Idempotent, as the real surface owner is: closing a pane that is already gone reconciles
        // rather than failing, which is what makes redispatch at this position safe.
        state.counters.paneCloses += 1;
        state.closedPanes.add(input.paneId);
      }),
  };

  const headless: HeadlessOperationAdapter = {
    assertCanCreateProcess: () =>
      state.controlPlaneBlocked ? Effect.fail(state.controlPlaneBlocked) : Effect.void,
    allocate: () =>
      Effect.gen(function* () {
        yield* failIfConfigured(state, 'allocate');
        state.counters.allocations += 1;
        yield* gateFor(state, 'allocate');
        const ptyProcessId = state.nextPtyProcessId++;
        const outcome =
          state.launchOutcomes.length > 1
            ? state.launchOutcomes.shift()!
            : (state.launchOutcomes[0] ?? { kind: 'spawned' as const });
        const allocation: PtyProcessAllocation = {
          ptyProcessId,
          start: Effect.suspend(() => {
            state.counters.starts += 1;
            if (outcome.kind === 'hang') {
              return Effect.never as Effect.Effect<PtyProcessLaunchMetadata>;
            }
            if (outcome.kind === 'interrupted') {
              // Exactly what an interrupted `start` does: returns nothing at all, leaving the stage
              // marker that preceded it as the only durable evidence.
              return Effect.interrupt as Effect.Effect<PtyProcessLaunchMetadata>;
            }
            return Effect.succeed({
              ptyProcessId,
              command: 'fake',
              args: [],
              cwd: '/repo/fixture',
              logPath: null,
              launchOutcome: outcome.kind,
              launchFailureCause: outcome.kind === 'spawned' ? null : outcome.cause,
            } satisfies PtyProcessLaunchMetadata);
          }),
          abandon: Effect.sync(() => {
            state.abandoned.push(ptyProcessId);
          }),
        };
        return allocation;
      }),
    pin: () => Effect.void,
    unpin: () => Effect.void,
    capture: (input) =>
      Effect.succeed(state.capturedOutput.get(input.ptyProcessId) ?? { raw: '', output: '' }),
    terminate: (input) =>
      Effect.suspend(() => {
        state.counters.terminations += 1;
        const outcome = state.terminateOutcome(input.ptyProcessId);
        return outcome instanceof Error ? Effect.fail(outcome) : Effect.succeed(outcome);
      }),
    semanticError: () => null,
  };

  return { agentSessions, panes, headless };
}

/**
 * A repository that dies when a named stage is about to be written.
 *
 * This is how a crash is simulated honestly: the write *before* the boundary is already committed
 * and the confirming write never lands, which is exactly the durable state a killed process leaves.
 * Mocking the recovery input instead would let a test assert against a shape no crash can produce.
 */
export function crashingOperationsRepository(
  inner: WorkflowOperationsRepositoryService,
  crashAt: { stages?: readonly WorkflowOperationStage[]; onSettle?: boolean },
): WorkflowOperationsRepositoryService {
  const stages = new Set<string>(crashAt.stages ?? []);
  return {
    ...inner,
    recordReceipt: (input) =>
      stages.has(input.stage)
        ? Effect.die(new Error(`simulated crash before recording stage ${input.stage}`))
        : inner.recordReceipt(input),
    settle: (input) =>
      crashAt.onSettle
        ? // A failed settlement transaction, which rolls back: nothing is written, so nothing may be
          // announced either. Modelled as the error the repository would raise rather than as a
          // defect, so the caller's own handling is what the test exercises.
          Effect.fail(
            new DatabaseError({
              operation: 'workflow_settle_operation',
              cause: new Error('simulated settlement transaction failure'),
            }),
          )
        : inner.settle(input),
  };
}

/**
 * What a *separate* database connection could see at the moment a notification was published.
 *
 * Reading through the connection that did the writing proves nothing about commit — SQLite lets a
 * connection observe its own uncommitted work. A second connection to the same file cannot see the
 * row until the transaction has actually committed, which is the property "persist before publish"
 * is actually claiming.
 */
export interface PublishObservation {
  readonly operationId: number;
  readonly state: string | null;
  readonly settledAt: string | null;
}

export interface OperationHarness {
  readonly fixture: WorkflowPersistenceFixture;
  readonly state: FakeAdapterState;
  readonly events: InternalRuntimeEvent[];
  /** One entry per settlement notification, recorded through an independent reader. */
  readonly publishObservations: PublishObservation[];
  readonly identity: OperationAttemptIdentity;
  readonly worktreeId: number;
  readonly surfaceId: number;
  /**
   * Build a service instance. Each call is a fresh runtime incarnation, which is what makes
   * "the incarnation that owned this capture has ended" testable without restarting a process.
   */
  readonly service: (options?: {
    readonly incarnationId?: string;
    readonly operations?: WorkflowOperationsRepositoryService;
    readonly now?: () => string;
  }) => Promise<{
    readonly service: WorkflowOperationServiceShape;
    readonly bus: InternalRuntimeEventBusService;
    readonly close: () => Promise<void>;
  }>;
  /**
   * Advance the run to a second visit of the same node, and return the identity for it.
   *
   * A revisit is a genuinely new execution, not a reopened one, which is exactly why operation
   * identity is keyed to `(executionId, callIndex)` — the same authored call in a new visit is new
   * work and must perform its effect again.
   */
  readonly nextVisit: () => Promise<OperationAttemptIdentity>;
  readonly close: () => void;
}

/**
 * A run parked mid-callback with a real claimed attempt, against a real database.
 *
 * The operation service is tested against the same repositories and payload store production uses;
 * only the external owners are faked, because they are the boundary this phase is about.
 */
export async function makeOperationHarness(): Promise<OperationHarness> {
  const fixture = makeWorkflowPersistenceFixture();
  fixture.seedArtifact(PIN);
  const placement = fixture.seedPlacement();
  const created = expectOk(
    await run(
      fixture.runs.createRun({
        workflowKey: 'fixture',
        title: 'Fixture',
        rootGraphKey: 'root',
        artifactHash: PIN,
        rootFrame: { graphKey: 'root' },
        origin: {
          worktreeId: placement.worktreeId,
          worktreePath: '/repo/fixture',
          surfaceId: placement.surfaceId,
          paneId: null,
          agentSessionId: null,
        },
        destination: {
          worktreeId: placement.worktreeId,
          worktreePath: '/repo/fixture',
          surfaceId: placement.surfaceId,
        },
        attachment: { worktreeId: placement.worktreeId, surfaceId: placement.surfaceId },
      }),
    ),
  );
  const entry = expectOk(
    await run(
      fixture.runs.claimSegment({
        ...(await prepareClaim(fixture, created.run.id)),
        owner: OWNER,
        ownerIncarnation: OWNER_INCARNATION,
      }),
    ),
  );
  await run(
    fixture.runs.commitGraphEntry({
      runId: created.run.id,
      attemptId: entry.attempt.id,
      owner: OWNER,
      ownerIncarnation: OWNER_INCARNATION,
      frameId: created.frame.id,
      state: { value: {} },
      entryNode: { nodeId: 'work', nodeKind: 'operation' },
    }),
  );
  const ready = (await run(fixture.runs.findRun(created.run.id)))!;
  const callback = expectOk(
    await run(
      fixture.runs.claimSegment({
        ...(await prepareClaim(fixture, ready.id)),
        owner: OWNER,
        ownerIncarnation: OWNER_INCARNATION,
      }),
    ),
  );

  const state = makeFakeAdapterState();
  const events: InternalRuntimeEvent[] = [];
  const publishObservations: PublishObservation[] = [];
  const adapters = makeFakeAdapters(state);
  // A second connection to the same database file, opened read-only. It is deliberately not the
  // fixture's client: the point is to see only what has been committed.
  const independentReader = new BetterSqlite(join(fixture.root, 'isagi.db'), { readonly: true });

  const identity: OperationAttemptIdentity = {
    runId: created.run.id,
    frameId: created.frame.id,
    executionId: callback.attempt.executionId!,
    attemptId: callback.attempt.id,
    attemptIndex: callback.attempt.attemptIndex,
    invocationKind: callback.attempt.invocationKind,
    artifactHash: PIN,
    destination: {
      worktreeId: placement.worktreeId,
      worktreePath: '/repo/fixture',
      surfaceId: placement.surfaceId,
    },
  };

  let clock = 0;
  const defaultNow = () => `2026-06-18T00:00:${String(clock++).padStart(2, '0')}.000Z`;

  const harness: OperationHarness = {
    fixture,
    state,
    events,
    publishObservations,
    identity,
    worktreeId: placement.worktreeId,
    surfaceId: placement.surfaceId,
    service: async (options) => {
      const scope = await Effect.runPromise(Scope.make());
      // The real bus, built into this scope, so the service's own subscriber loop runs against
      // production delivery semantics — type filters, unbounded queues, unsubscribe — rather than
      // against a hand-written fake's. Publications are recorded by decorating it, not replacing it.
      const context = await Effect.runPromise(
        Scope.extend(Layer.build(InternalRuntimeEventBusLive), scope),
      );
      const live = Context.get(context, InternalRuntimeEventBus);
      const recording: InternalRuntimeEventBusService = {
        publish: (event) =>
          Effect.tap(live.publish(event), () =>
            Effect.sync(() => {
              events.push(event);
              if (event.type !== 'workflow_operation_settled') return;
              // Read *at publication time*, through the independent connection, so the recorded
              // observation is what a woken subscriber could actually have found.
              const row = independentReader
                .prepare(`SELECT state, settled_at FROM workflow_operations WHERE id = ?`)
                .get(event.operationId) as { state: string; settled_at: string | null } | undefined;
              publishObservations.push({
                operationId: event.operationId,
                state: row?.state ?? null,
                settledAt: row?.settled_at ?? null,
              });
            }),
          ),
        subscribe: (filter) => live.subscribe(filter),
      };
      const service = await Effect.runPromise(
        Scope.extend(
          makeWorkflowOperationService({
            operations: options?.operations ?? fixture.operations,
            runs: fixture.runs,
            payloads: fixture.payloads,
            adapters,
            eventBus: recording,
            now: options?.now ?? defaultNow,
            ...(options?.incarnationId ? { incarnationId: options.incarnationId } : {}),
          }),
          scope,
        ),
      );
      return {
        service,
        bus: recording,
        close: async () => {
          await Effect.runPromise(Scope.close(scope, Exit.void));
        },
      };
    },
    nextVisit: async () => {
      const current = (await run(fixture.runs.findRun(identity.runId)))!;
      const held = current.activeAttemptId;
      if (held !== null) {
        expectOk(
          await run(
            fixture.runs.commitNodeResult({
              runId: identity.runId,
              attemptId: held,
              owner: OWNER,
              ownerIncarnation: OWNER_INCARNATION,
              frameId: identity.frameId,
              executionId: identity.executionId,
              state: { value: {} },
              producerOutput: { value: { update: {} } },
              producerArtifactHash: PIN,
              next: { kind: 'routing', edgeId: 'work-out' },
            }),
          ),
        );
      }
      const routingRun = (await run(fixture.runs.findRun(identity.runId)))!;
      const routing = expectOk(
        await run(
          fixture.runs.claimSegment({
            ...(await prepareClaim(fixture, routingRun.id)),
            owner: OWNER,
            ownerIncarnation: OWNER_INCARNATION,
          }),
        ),
      );
      expectOk(
        await run(
          fixture.runs.commitRouting({
            runId: identity.runId,
            attemptId: routing.attempt.id,
            owner: OWNER,
            ownerIncarnation: OWNER_INCARNATION,
            frameId: identity.frameId,
            executionId: identity.executionId,
            state: { value: {} },
            producerOutput: { value: { to: 'work' } },
            producerArtifactHash: PIN,
            next: { kind: 'node', nodeId: 'work', nodeKind: 'operation' },
          }),
        ),
      );
      const readyRun = (await run(fixture.runs.findRun(identity.runId)))!;
      const revisit = expectOk(
        await run(
          fixture.runs.claimSegment({
            ...(await prepareClaim(fixture, readyRun.id)),
            owner: OWNER,
            ownerIncarnation: OWNER_INCARNATION,
          }),
        ),
      );
      return {
        ...identity,
        executionId: revisit.attempt.executionId!,
        attemptId: revisit.attempt.id,
        attemptIndex: revisit.attempt.attemptIndex,
        invocationKind: revisit.attempt.invocationKind,
      };
    },
    close: () => {
      independentReader.close();
      fixture.close();
    },
  };
  return harness;
}

/**
 * Run an Effect and surface its expected failure as itself.
 *
 * `Effect.runPromise` rejects with a `FiberFailure` wrapping the real error, which would make every
 * assertion about an author-facing `code` assert against the wrapper instead. Tests unwrap here for
 * the same reason the verbs do.
 */
export function runCallback<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromiseExit(effect).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    const failure = Cause.failureOption(exit.cause);
    if (Option.isSome(failure)) throw failure.value;
    throw Cause.squash(exit.cause);
  });
}

/** A gate a test opens once it has applied whatever control it wanted to land mid-flight. */
export function openableGate(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { promise, open };
}

export function expectOk<A>(result: {
  readonly ok: boolean;
  readonly value?: A;
  readonly rejection?: unknown;
}): A {
  if (!result.ok)
    throw new Error(`expected a committed write: ${JSON.stringify(result.rejection)}`);
  return result.value as A;
}

export { run };
