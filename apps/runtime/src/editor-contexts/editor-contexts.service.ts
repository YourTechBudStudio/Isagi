import { Context, Deferred, Effect, Either, Fiber, Layer } from 'effect';

import type { EditorAttemptFailureReason, EditorDiagnosticsOutput } from '@isagi/contracts';

import { describeOperationalCause } from '../diagnostics/operational-cause.js';
import {
  EditorProvisioning,
  type EditorUnavailable,
  type ResolvedEditorInstallation,
} from '../editor-provisioning/index.js';
import {
  EntityLock,
  entityLockKeyId,
  type EntityLockHeld,
  type EntityLockKey,
} from '../lib/locks/entity-lock.js';
import { LoopbackPortProbe } from '../lib/net/loopback-port-probe.js';
import type { DatabaseError } from '../persistence/index.js';
import { PtyService, type PtyTerminateOutcome } from '../pty-processes/index.js';
import { InternalRuntimeEventBus } from '../runtime-events/index.js';
import { WorkspaceRepository } from '../workspace/index.js';
import { EditorContextRepository } from './editor-contexts.repository.js';
import { EditorDiagnosticsUnavailable, EditorError, EditorLaunchFailed } from './errors.js';
import { deriveEditorContextFacts } from './projection.js';
import { probeWorkbench, type EditorProbeRequest, type EditorProbeTiming } from './readiness.js';
import { launchEditorIncarnation, type EditorLaunchDependencies } from './service/launch.js';
import type { EditorContextFacts, EditorContextRow, EditorReadinessObservation } from './types.js';

/**
 * The lock every editor operation serializes on.
 *
 * The key is the **worktree** id, not the context id, because placement has to
 * hold the lock before a context exists. One context per worktree makes the two
 * identities interchangeable once it does, so nothing is lost by naming the one
 * that is always available. This is the single definition; both domains use it.
 */
export function editorLockKey(worktreeId: number): EntityLockKey {
  return { kind: 'editor_context', id: worktreeId };
}

/** The bounded tail of retained startup output one diagnostics read may return. */
export const editorDiagnosticsMaxBytes = 16 * 1_024;

/**
 * Two graceful-stop policies, named apart so they cannot be swapped by accident.
 * Replacement is a user waiting on a new editor; release is cleanup behind a
 * deletion that has already happened.
 */
export const editorReplaceGracefulTimeoutMs = 2_000;
export const editorReleaseGracefulTimeoutMs = 1_000;

export interface EditorContextServiceShape {
  /**
   * The Class C guard both operations call first, and the same one the palette's
   * availability path uses. A façade over provisioning on purpose: the editor
   * domain stays the single door, so no other layer has to learn how
   * provisioning models capability.
   */
  readonly requireAvailable: Effect.Effect<ResolvedEditorInstallation, EditorUnavailable>;
  readonly findForWorktree: (
    worktreeId: number,
  ) => Effect.Effect<EditorContextRow | null, DatabaseError>;
  /** Called by placement while it holds `editorLockKey(worktreeId)`; the witness proves it. */
  readonly createForWorktree: (input: {
    readonly held: EntityLockHeld;
    readonly worktreeId: number;
  }) => Effect.Effect<EditorContextRow, DatabaseError>;
  /**
   * Takes the lock itself, after reading the context's worktree, and re-reads the
   * row inside it. Returns the editor's own facts — never a pane projection,
   * because placement is not this domain's to know.
   */
  readonly ensureRuntime: (input: {
    readonly editorContextId: number;
    readonly intent: 'reuse' | 'replace';
  }) => Effect.Effect<
    EditorContextFacts,
    DatabaseError | EditorError | EditorUnavailable | EditorLaunchFailed
  >;
  /**
   * Called by the deletion path with the lock already held, for a context it has
   * already established is unplaced. Never fails on a termination problem: an
   * unconfirmed stop is recorded on the row instead, because a cleanup that can
   * refuse would make placement removal fail for a reason the user cannot act on.
   */
  readonly releaseIncarnation: (input: {
    readonly held: EntityLockHeld;
    readonly editorContextId: number;
  }) => Effect.Effect<void, DatabaseError>;
  /** The in-memory half of the read projection, composed by surface detail. */
  readonly readinessFor: (
    ptyProcessIds: readonly number[],
  ) => Effect.Effect<ReadonlyMap<number, EditorReadinessObservation>>;
  readonly diagnostics: (input: {
    readonly editorContextId: number;
    /**
     * The incarnation the caller believes it is reading. A mismatch with the
     * context's current pointer is refused, never silently redirected.
     */
    readonly ptyProcessId: number;
  }) => Effect.Effect<
    EditorDiagnosticsOutput,
    DatabaseError | EditorError | EditorDiagnosticsUnavailable
  >;
}

export const EditorContextService = Context.GenericTag<EditorContextServiceShape>(
  'isagi/EditorContextService',
);

export interface EditorContextServiceOptions {
  /**
   * The whole probe, not its HTTP internals.
   *
   * Service tests care about probe *lifecycle* — registered before start, ended
   * by supersession or a terminal event, cleaned up at shutdown — and stubbing
   * here keeps them from also asserting the HTTP polling behaviour that
   * `readiness.test.ts` owns. `probeRequest`/`probeTiming` are the narrower seam
   * for a test that wants the real probe on a scripted transport.
   */
  readonly probe?: EditorProbeRunner | undefined;
  readonly probeRequest?: EditorProbeRequest | undefined;
  readonly probeTiming?: Partial<EditorProbeTiming> | undefined;
}

export type EditorProbeRunner = (input: {
  readonly host: string;
  readonly port: number;
  readonly onSettled: (settlement: {
    readonly state: 'ready' | 'unreachable';
    readonly detail: string | null;
  }) => Effect.Effect<void>;
}) => Effect.Effect<void>;

/**
 * The durable editor context's runtime domain: it owns the context's replaceable
 * Code Server incarnation and everything this runtime knows about it.
 *
 * Three facts shape the whole module. Readiness is memory-only and keyed by PTY
 * process id, so it can never describe an incarnation other than the one it was
 * observed on. Ownership is committed before a process starts, so no editor
 * process is ever ownerless. And this service is the only interpreter of its
 * incarnations' PTY events, because the internal bus delivers each event to every
 * matching subscriber and a second interpreter would double every exit.
 */
export function makeEditorContextService(options: EditorContextServiceOptions = {}) {
  return Effect.gen(function* () {
    const repository = yield* EditorContextRepository;
    const workspace = yield* WorkspaceRepository;
    const pty = yield* PtyService;
    const provisioning = yield* EditorProvisioning;
    const portProbe = yield* LoopbackPortProbe;
    const entityLock = yield* EntityLock;
    const eventBus = yield* InternalRuntimeEventBus;
    const serviceScope = yield* Effect.scope;

    // All three keyed by PTY process id, so nothing here can outlive — or be
    // mistaken for — a different incarnation of the same context.
    const readiness = new Map<number, EditorReadinessObservation>();
    const probes = new Map<number, Fiber.RuntimeFiber<void, never>>();
    // Every incarnation this runtime launched, and which context owns it. It is
    // what lets the PTY-event subscriber recognize its own processes without a
    // database read per event, and its emptiness after a restart is exactly
    // right: an incarnation this runtime did not launch is not one it adopts.
    const incarnations = new Map<number, number>();

    const publishChanged = (editorContextId: number) =>
      eventBus.publish({ type: 'editor_context_changed', editorContextId });

    const now = () => new Date().toISOString();

    const factsFor = (row: EditorContextRow): EditorContextFacts =>
      deriveEditorContextFacts(
        row,
        row.activePtyProcessId === null ? undefined : readiness.get(row.activePtyProcessId),
      );

    const contextNotFound = (editorContextId: number) =>
      new EditorError({
        code: 'editor_context_not_found',
        message: `Editor context ${editorContextId} was not found.`,
        editorContextId,
      });

    const requireRow = (editorContextId: number) =>
      repository
        .find(editorContextId)
        .pipe(
          Effect.flatMap((row) =>
            row ? Effect.succeed(row) : Effect.fail(contextNotFound(editorContextId)),
          ),
        );

    /**
     * The witness proves *a* lock was held, not which one. Since `EntityLockKey`
     * is a three-member union, an agent-session witness — or the right kind for
     * the wrong worktree — is structurally acceptable without this check, and the
     * serialization the whole design rests on would be silently gone.
     */
    const assertEditorLockHeld = (held: EntityLockHeld, worktreeId: number) =>
      entityLockKeyId(held.key) === entityLockKeyId(editorLockKey(worktreeId))
        ? Effect.void
        : Effect.dieMessage(
            `Editor operation on worktree ${worktreeId} requires ${entityLockKeyId(
              editorLockKey(worktreeId),
            )}, but the caller held ${entityLockKeyId(held.key)}.`,
          );

    /**
     * End one incarnation's probe and drop its readiness, leaving ownership alone.
     *
     * The interrupt is awaited *before* the deletes: a probe interrupted mid
     * settlement could otherwise write its observation after the map was cleared,
     * leaving an entry for a dead process. Projection would refuse to call that
     * ready either way, but a map that is merely harmless is worse than one that
     * is correct.
     *
     * This deliberately does *not* touch `incarnations`. Stopping the probe is
     * something every path does speculatively, before it knows whether the
     * process actually died; forgetting who owns the process is only correct once
     * that is known.
     */
    const interruptProbe = (ptyProcessId: number) =>
      Effect.gen(function* () {
        const fiber = probes.get(ptyProcessId);
        if (fiber) yield* Fiber.interrupt(fiber);
        probes.delete(ptyProcessId);
        readiness.delete(ptyProcessId);
      });

    /**
     * Interrupt the probe *and* forget that this runtime owns the incarnation.
     *
     * Only affirmative evidence justifies this: a confirmed stop, a terminal PTY
     * event, or shutdown. While an incarnation stays registered, the PTY-event
     * subscriber still recognizes it — which is what keeps a process whose
     * termination was refused able to publish its own terminal transition later,
     * instead of vanishing from this runtime's view while still owned durably.
     */
    const forgetIncarnation = (ptyProcessId: number) =>
      interruptProbe(ptyProcessId).pipe(
        Effect.tap(() => Effect.sync(() => incarnations.delete(ptyProcessId))),
      );

    /**
     * Seed the pending observation and fork the probe, returning only once the
     * fiber is registered.
     *
     * The gate makes "registered before probing" literal rather than a bet on the
     * scheduler. Without it a probe that settles immediately — which an injected
     * timing makes ordinary — could remove itself from `probes` before this ever
     * inserted it, leaving a completed fiber registered for the incarnation's
     * whole life.
     */
    const registerProbe = (input: {
      readonly editorContextId: number;
      readonly ptyProcessId: number;
      readonly host: string;
      readonly port: number;
    }) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        readiness.set(input.ptyProcessId, {
          ptyProcessId: input.ptyProcessId,
          state: 'pending',
          detail: null,
          observedAt: now(),
        });
        incarnations.set(input.ptyProcessId, input.editorContextId);

        const onSettled = (settlement: {
          readonly state: 'ready' | 'unreachable';
          readonly detail: string | null;
        }) =>
          Effect.gen(function* () {
            readiness.set(input.ptyProcessId, {
              ptyProcessId: input.ptyProcessId,
              state: settlement.state,
              detail: settlement.detail,
              observedAt: now(),
            });
            // Only the fiber is forgotten. The observation is retained so a later
            // mount reads the settled result instead of re-probing, and the
            // incarnation stays recognizable to the event subscriber.
            probes.delete(input.ptyProcessId);
            yield* publishChanged(input.editorContextId);
          });

        const run: EditorProbeRunner =
          options.probe ??
          ((probeInput) =>
            probeWorkbench({
              ...probeInput,
              request: options.probeRequest,
              timing: options.probeTiming,
            }));

        const fiber = yield* Effect.forkIn(
          Deferred.await(gate).pipe(
            Effect.zipRight(run({ host: input.host, port: input.port, onSettled })),
          ),
          serviceScope,
        );
        probes.set(input.ptyProcessId, fiber);
        yield* Deferred.succeed(gate, undefined);
      });

    /**
     * Persist a Class B failure and publish it, reporting whether it committed.
     *
     * Raising is deliberately *not* part of this: the interruption finalizer must
     * persist without raising, and every other caller must raise only after this
     * has committed. Splitting the two is what keeps "persist, then raise" a
     * single rule with no exceptions rather than a convention each call site
     * re-implements.
     */
    const commitAttemptFailure = (input: {
      readonly editorContextId: number;
      readonly reason: EditorAttemptFailureReason;
      readonly detail: string | null;
    }) =>
      repository
        .markAttemptFailed(input)
        .pipe(
          Effect.tap((outcome) =>
            outcome === 'applied' ? publishChanged(input.editorContextId) : Effect.void,
          ),
        );

    const launchDependencies: EditorLaunchDependencies = {
      repository,
      workspace,
      pty,
      portProbe,
      commitAttemptFailure,
      publishChanged,
      registerProbe,
    };

    /**
     * Stop one incarnation, treating "it was already gone" as an affirmative
     * absence.
     *
     * Everything else — any other service error, a kill failure, a termination
     * already in progress — means the same product fact: the previous editor may
     * still be alive and this attempt did not stop it. Nothing may be cleared on
     * that evidence.
     */
    const stopIncarnation = (ptyProcessId: number, gracefulTimeoutMs: number) =>
      pty.terminate({ ptyProcessId, gracefulTimeoutMs }).pipe(
        Effect.catchTag('PtyServiceError', (error) =>
          error.code === 'session_not_found'
            ? Effect.succeed<PtyTerminateOutcome>('already_absent')
            : Effect.fail(error),
        ),
        Effect.either,
      );

    const launchFrom = (row: EditorContextRow, installation: ResolvedEditorInstallation) =>
      launchEditorIncarnation({
        deps: launchDependencies,
        row,
        installation,
      }).pipe(Effect.zipRight(requireRow(row.id)), Effect.map(factsFor));

    const openAttempt = (editorContextId: number) =>
      repository
        .markAttemptInProgress(editorContextId)
        .pipe(Effect.flatMap((outcome) => settleTransition(editorContextId, outcome)));

    const settleTransition = (editorContextId: number, outcome: 'applied' | 'context_missing') =>
      outcome === 'applied'
        ? publishChanged(editorContextId)
        : Effect.fail(contextNotFound(editorContextId));

    const runEnsure = (
      editorContextId: number,
      intent: 'reuse' | 'replace',
      installation: ResolvedEditorInstallation,
    ) =>
      Effect.gen(function* () {
        // Re-read inside the lock. The row read to find the worktree was read
        // outside it and may already be stale.
        const row = yield* requireRow(editorContextId);

        if (intent === 'reuse') {
          if (row.activePtyProcessId !== null) {
            // Branches 1 and 4 have the same implementation because they have the
            // same behaviour: neither touches the row, the maps, or the process.
            // What separates "reuse a working editor" from "report a settled
            // failure" is entirely what the projection derives, so expressing it
            // as two code paths would only create two ways to accidentally mutate.
            return factsFor(row);
          }
          if (row.attempt.state !== 'none') {
            // An attempt already in flight, or a settled failure. Retry is the
            // user's move, and it is `replace`.
            return factsFor(row);
          }
          yield* openAttempt(editorContextId);
          return yield* launchFrom(row, installation);
        }

        if (row.activePtyProcessId !== null) {
          const ptyProcessId = row.activePtyProcessId;
          // Interrupt before terminating: the probe would otherwise race the
          // process it is polling and settle against a corpse.
          yield* interruptProbe(ptyProcessId);
          const outcome = yield* stopIncarnation(ptyProcessId, editorReplaceGracefulTimeoutMs);
          if (Either.isLeft(outcome)) {
            // Ownership survives, endpoint and all. Creating a replacement
            // alongside a process that may still be alive is the one thing this
            // path must never do.
            const committed = yield* commitAttemptFailure({
              editorContextId,
              reason: 'previous_incarnation_not_stopped',
              detail: describeOperationalCause(outcome.left),
            });
            return yield* Effect.fail(
              committed === 'applied'
                ? new EditorLaunchFailed({
                    editorContextId,
                    reason: 'previous_incarnation_not_stopped',
                    detail: describeOperationalCause(outcome.left),
                  })
                : contextNotFound(editorContextId),
            );
          }
          // Affirmatively stopped, so ownership of the old process is over.
          yield* forgetIncarnation(ptyProcessId);
          yield* repository
            .clearIncarnationAndMarkInProgress(editorContextId)
            .pipe(Effect.flatMap((result) => settleTransition(editorContextId, result)));
        } else {
          yield* openAttempt(editorContextId);
        }

        return yield* launchFrom(yield* requireRow(editorContextId), installation);
      });

    const service: EditorContextServiceShape = {
      requireAvailable: provisioning.requireReady,

      findForWorktree: repository.findByWorktree,

      createForWorktree: ({ held, worktreeId }) =>
        assertEditorLockHeld(held, worktreeId).pipe(
          Effect.zipRight(repository.create({ worktreeId })),
        ),

      ensureRuntime: ({ editorContextId, intent }) =>
        Effect.gen(function* () {
          // The capability refusal comes first: an operation on a runtime that
          // has no editor should not take a lock to find that out.
          const installation = yield* provisioning.requireReady;
          const row = yield* requireRow(editorContextId);
          return yield* entityLock.withLock(editorLockKey(row.worktreeId), () =>
            runEnsure(editorContextId, intent, installation),
          );
        }),

      releaseIncarnation: ({ held, editorContextId }) =>
        Effect.gen(function* () {
          const row = yield* repository.find(editorContextId);
          // The context is already gone: cleanup has converged on its goal.
          if (!row) return;
          yield* assertEditorLockHeld(held, row.worktreeId);
          if (row.activePtyProcessId === null) return;

          const ptyProcessId = row.activePtyProcessId;
          yield* interruptProbe(ptyProcessId);
          const outcome = yield* stopIncarnation(ptyProcessId, editorReleaseGracefulTimeoutMs);
          if (Either.isLeft(outcome)) {
            // The row keeps its pointer and records why. Failing here would make
            // deleting a surface depend on a process that may not answer, which
            // is a cleanup problem the user cannot act on.
            yield* commitAttemptFailure({
              editorContextId,
              reason: 'previous_incarnation_not_stopped',
              detail: describeOperationalCause(outcome.left),
            });
            return;
          }
          yield* forgetIncarnation(ptyProcessId);
          yield* repository
            .clearIncarnation(editorContextId)
            .pipe(
              Effect.flatMap((result) =>
                result === 'applied' ? publishChanged(editorContextId) : Effect.void,
              ),
            );
        }),

      readinessFor: (ptyProcessIds) =>
        Effect.sync(() => {
          const observed = new Map<number, EditorReadinessObservation>();
          for (const ptyProcessId of ptyProcessIds) {
            const observation = readiness.get(ptyProcessId);
            if (observation) observed.set(ptyProcessId, observation);
          }
          return observed;
        }),

      diagnostics: ({ editorContextId, ptyProcessId }) =>
        Effect.gen(function* () {
          const row = yield* requireRow(editorContextId);
          if (row.activePtyProcessId !== ptyProcessId) {
            // A durable context outlives its incarnations and a replacement
            // reuses its id, so answering from the current pointer would
            // misattribute one incarnation's output to another. That is exactly
            // the evidence the user is being asked to report.
            return yield* Effect.fail(
              new EditorError({
                code: 'editor_incarnation_superseded',
                message: `PTY process ${ptyProcessId} is no longer the current incarnation of editor context ${editorContextId}.`,
                editorContextId,
                ptyProcessId,
              }),
            );
          }
          const tail = yield* pty
            .readLogTail({ ptyProcessId, maxBytes: editorDiagnosticsMaxBytes })
            .pipe(
              Effect.catchTag('PtyServiceError', (error) =>
                // "Nothing was retained" is a successful empty answer from the
                // PTY layer. Reaching here means the log exists and could not be
                // read, which is a different fact and the only one worth a retry.
                Effect.fail(
                  new EditorDiagnosticsUnavailable({
                    editorContextId,
                    detail: describeOperationalCause(error),
                  }),
                ),
              ),
            );
          return {
            editorContextId,
            ptyProcessId,
            excerpt: tail.excerpt,
            truncated: tail.truncated,
            totalBytes: tail.totalBytes,
          };
        }),
    };

    // Construction step 3, registered first so nothing forked below can outlive
    // it: interrupt every live probe and drop the in-memory state.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        for (const fiber of probes.values()) yield* Fiber.interrupt(fiber);
        probes.clear();
        readiness.clear();
        incarnations.clear();
      }),
    );

    // Construction step 1 — boot convergence. Every `in_progress` row belongs to
    // an attempt this runtime cannot possibly still be making, and the invariant
    // that a pointer never coexists with `in_progress` is what makes that
    // unambiguous rather than a guess.
    const interrupted = yield* repository.failInterruptedAttempts;
    yield* Effect.forEach(interrupted, publishChanged, { discard: true });

    // Construction step 2 — the single interpreter of editor PTY events.
    const subscription = yield* eventBus.subscribe({
      types: ['pty_process_exited', 'pty_process_failed', 'pty_process_killed'],
    });
    yield* Effect.forkIn(
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
          const editorContextId = incarnations.get(event.ptyProcessId);
          // Not an incarnation this runtime launched, so not this subscriber's to
          // interpret. Every other domain's processes leave here without a query.
          if (editorContextId === undefined) return;
          // Terminal evidence: the process is gone, so ownership of it is over.
          yield* forgetIncarnation(event.ptyProcessId);
          const row = yield* repository.find(editorContextId);
          if (row) yield* publishChanged(editorContextId);
        }).pipe(
          Effect.catchAll((error) =>
            Effect.logWarning(
              `[runtime] editor PTY event handling failed cause=${describeOperationalCause(error)}`,
            ),
          ),
        ),
      ),
      serviceScope,
    );

    return service;
  });
}

export const EditorContextServiceLive = Layer.scoped(
  EditorContextService,
  makeEditorContextService(),
);
