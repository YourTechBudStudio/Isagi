import { Context, Effect, FiberMap, Layer, Result, Stream } from 'effect';

import type { EditorAttemptFailureReason, EditorDiagnosticsOutput } from '@isagi/contracts';

import { describeOperationalCause } from '../../platform/diagnostics/index.js';
import { InternalEvents } from '../../platform/events/index.js';
import {
  EntityLock,
  entityLockKeyId,
  type EntityLockHeld,
  type EntityLockKey,
} from '../../platform/locks/index.js';
import { LoopbackPortProbe } from '../../platform/net/index.js';
import type { DatabaseError } from '../../platform/persistence/index.js';
import { ProjectRepository } from '../../projects/index.js';
import {
  interruptedByRuntime,
  PtyService,
  type PtyTerminateOutcome,
} from '../../pty-processes/index.js';
import { type ResolvedEditorInstallation } from '../provisioning/install.js';
import { EditorProvisioning, type EditorUnavailable } from '../provisioning/service.js';
import { EditorDiagnosticsUnavailable, EditorError, EditorLaunchFailed } from './errors.js';
import { launchEditorIncarnation, type EditorLaunchDependencies } from './launch.js';
import { deriveEditorContextFacts } from './projection.js';
import { EditorReadinessProbe, type EditorReadinessSettlement } from './readiness.js';
import { EditorContextRepository } from './repository.js';
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
const make = Effect.gen(function* () {
  const repository = yield* EditorContextRepository;
  const workspace = yield* ProjectRepository;
  const pty = yield* PtyService;
  const provisioning = yield* EditorProvisioning;
  const portProbe = yield* LoopbackPortProbe;
  const entityLock = yield* EntityLock;
  const eventBus = yield* InternalEvents;
  const probe = yield* EditorReadinessProbe;

  // Both keyed by PTY process id, so nothing here can outlive — or be mistaken
  // for — a different incarnation of the same context.
  const readiness = new Map<number, EditorReadinessObservation>();
  // Every incarnation this runtime launched, and which context owns it. It is
  // what lets the PTY-event subscriber recognize its own processes without a
  // database read per event, and its emptiness after a restart is exactly
  // right: an incarnation this runtime did not launch is not one it adopts.
  const incarnations = new Map<number, number>();

  // Construction step 3, registered first so it runs last: once the probe map
  // below has interrupted every live probe, drop the in-memory state.
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      readiness.clear();
      incarnations.clear();
    }),
  );

  // One probe fiber per live incarnation, keyed like the maps above. A fiber
  // leaves the map when it settles; the layer scope interrupts every one left.
  const probes = yield* FiberMap.make<number, void, never>();

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

  const requireRow = Effect.fnUntraced(function* (editorContextId: number) {
    const row = yield* repository.find(editorContextId);
    if (!row) return yield* contextNotFound(editorContextId);
    return row;
  });

  /**
   * The witness proves *a* lock was held, not which one. Since `EntityLockKey`
   * is a three-member union, an agent-session witness — or the right kind for
   * the wrong worktree — is structurally acceptable without this check, and the
   * serialization the whole design rests on would be silently gone.
   */
  const assertEditorLockHeld = (held: EntityLockHeld, worktreeId: number) =>
    entityLockKeyId(held.key) === entityLockKeyId(editorLockKey(worktreeId))
      ? Effect.void
      : Effect.die(
          new Error(
            `Editor operation on worktree ${worktreeId} requires ${entityLockKeyId(
              editorLockKey(worktreeId),
            )}, but the caller held ${entityLockKeyId(held.key)}.`,
          ),
        );

  /**
   * End one incarnation's probe and drop its readiness, leaving ownership alone.
   *
   * The interrupt is awaited *before* the delete: a probe interrupted mid
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
  const interruptProbe = Effect.fnUntraced(function* (ptyProcessId: number) {
    yield* FiberMap.remove(probes, ptyProcessId);
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
  const forgetIncarnation = Effect.fnUntraced(function* (ptyProcessId: number) {
    yield* interruptProbe(ptyProcessId);
    incarnations.delete(ptyProcessId);
  });

  /**
   * Seed the pending observation and fork the probe, returning only once the
   * fiber is registered.
   *
   * The fiber is added to the map before it first runs (`startImmediately:
   * false`), which makes "registered before probing" literal rather than a bet
   * on the scheduler: a probe that settles immediately — which an injected
   * runner makes ordinary — still leaves the map only through its own
   * completion, never before it was inserted.
   */
  const registerProbe = Effect.fnUntraced(function* (input: {
    readonly editorContextId: number;
    readonly ptyProcessId: number;
    readonly host: string;
    readonly port: number;
  }) {
    readiness.set(input.ptyProcessId, {
      ptyProcessId: input.ptyProcessId,
      state: 'pending',
      detail: null,
      observedAt: now(),
    });
    incarnations.set(input.ptyProcessId, input.editorContextId);

    // Uninterruptible, so a supersession landing mid settlement waits for the
    // observation and its change event rather than cutting between them; the
    // supersession then drops the observation itself. The observation is
    // retained after settling so a later mount reads the settled result instead
    // of re-probing, and the incarnation stays recognizable to the subscriber.
    const onSettled = (settlement: EditorReadinessSettlement) =>
      Effect.uninterruptible(
        Effect.suspend(() => {
          readiness.set(input.ptyProcessId, {
            ptyProcessId: input.ptyProcessId,
            state: settlement.state,
            detail: settlement.detail,
            observedAt: now(),
          });
          return publishChanged(input.editorContextId);
        }),
      );

    yield* FiberMap.run(
      probes,
      input.ptyProcessId,
      probe.run({ host: input.host, port: input.port, onSettled }),
      { startImmediately: false },
    );
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
  const commitAttemptFailure = Effect.fnUntraced(function* (input: {
    readonly editorContextId: number;
    readonly reason: EditorAttemptFailureReason;
    readonly detail: string | null;
  }) {
    const outcome = yield* repository.markAttemptFailed(input);
    if (outcome === 'applied') yield* publishChanged(input.editorContextId);
    return outcome;
  });

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
      Effect.result,
    );

  const launchFrom = Effect.fnUntraced(function* (
    row: EditorContextRow,
    installation: ResolvedEditorInstallation,
  ) {
    yield* launchEditorIncarnation({ deps: launchDependencies, row, installation });
    return factsFor(yield* requireRow(row.id));
  });

  const settleTransition = (editorContextId: number, outcome: 'applied' | 'context_missing') =>
    outcome === 'applied'
      ? publishChanged(editorContextId)
      : Effect.fail(contextNotFound(editorContextId));

  const openAttempt = Effect.fnUntraced(function* (editorContextId: number) {
    const outcome = yield* repository.markAttemptInProgress(editorContextId);
    yield* settleTransition(editorContextId, outcome);
  });

  const runEnsure = Effect.fnUntraced(function* (
    editorContextId: number,
    intent: 'reuse' | 'replace',
    installation: ResolvedEditorInstallation,
  ) {
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
      if (Result.isFailure(outcome)) {
        // Ownership survives, endpoint and all. Creating a replacement
        // alongside a process that may still be alive is the one thing this
        // path must never do.
        const committed = yield* commitAttemptFailure({
          editorContextId,
          reason: 'previous_incarnation_not_stopped',
          detail: describeOperationalCause(outcome.failure),
        });
        if (committed === 'context_missing') return yield* contextNotFound(editorContextId);
        return yield* new EditorLaunchFailed({
          editorContextId,
          reason: 'previous_incarnation_not_stopped',
          detail: describeOperationalCause(outcome.failure),
        });
      }
      // Affirmatively stopped, so ownership of the old process is over.
      yield* forgetIncarnation(ptyProcessId);
      const cleared = yield* repository.clearIncarnationAndMarkInProgress(editorContextId);
      yield* settleTransition(editorContextId, cleared);
    } else {
      yield* openAttempt(editorContextId);
    }

    return yield* launchFrom(yield* requireRow(editorContextId), installation);
  });

  /** One PTY terminal event, interpreted only when it names an incarnation this runtime launched. */
  const handleProcessEvent = Effect.fnUntraced(function* (event: {
    readonly ptyProcessId: number;
  }) {
    const editorContextId = incarnations.get(event.ptyProcessId);
    // Not an incarnation this runtime launched, so not this subscriber's to
    // interpret. Every other domain's processes leave here without a query.
    if (editorContextId === undefined) return;
    // Terminal evidence: the process is gone, so ownership of it is over.
    yield* forgetIncarnation(event.ptyProcessId);
    const row = yield* repository.find(editorContextId);
    if (row) yield* publishChanged(editorContextId);
  });

  const service = EditorContextService.of({
    requireAvailable: provisioning.requireReady,

    findForWorktree: repository.findByWorktree,

    createForWorktree: Effect.fn('EditorContextService.createForWorktree')(function* ({
      held,
      worktreeId,
    }) {
      yield* assertEditorLockHeld(held, worktreeId);
      return yield* repository.create({ worktreeId });
    }),

    ensureRuntime: Effect.fn('EditorContextService.ensureRuntime')(function* ({
      editorContextId,
      intent,
    }) {
      // The availability refusal comes first: an operation on a runtime whose
      // editor is not ready should not take a lock to find that out.
      const installation = yield* provisioning.requireReady;
      const row = yield* requireRow(editorContextId);
      return yield* entityLock.withLock(editorLockKey(row.worktreeId), () =>
        runEnsure(editorContextId, intent, installation),
      );
    }),

    releaseIncarnation: Effect.fn('EditorContextService.releaseIncarnation')(function* ({
      held,
      editorContextId,
    }) {
      const row = yield* repository.find(editorContextId);
      // The context is already gone: cleanup has converged on its goal.
      if (!row) return;
      yield* assertEditorLockHeld(held, row.worktreeId);
      if (row.activePtyProcessId === null) return;

      const ptyProcessId = row.activePtyProcessId;
      yield* interruptProbe(ptyProcessId);
      const outcome = yield* stopIncarnation(ptyProcessId, editorReleaseGracefulTimeoutMs);
      if (Result.isFailure(outcome)) {
        // The row keeps its pointer and records why. Failing here would make
        // deleting a surface depend on a process that may not answer, which
        // is a cleanup problem the user cannot act on.
        yield* commitAttemptFailure({
          editorContextId,
          reason: 'previous_incarnation_not_stopped',
          detail: describeOperationalCause(outcome.failure),
        });
        return;
      }
      yield* forgetIncarnation(ptyProcessId);
      const cleared = yield* repository.clearIncarnation(editorContextId);
      if (cleared === 'applied') yield* publishChanged(editorContextId);
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

    diagnostics: Effect.fn('EditorContextService.diagnostics')(function* ({
      editorContextId,
      ptyProcessId,
    }) {
      const row = yield* requireRow(editorContextId);
      if (row.activePtyProcessId !== ptyProcessId) {
        // A durable context outlives its incarnations and a replacement
        // reuses its id, so answering from the current pointer would
        // misattribute one incarnation's output to another. That is exactly
        // the evidence the user is being asked to report.
        return yield* new EditorError({
          code: 'editor_incarnation_superseded',
          message: `PTY process ${ptyProcessId} is no longer the current incarnation of editor context ${editorContextId}.`,
          editorContextId,
          ptyProcessId,
        });
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
  });

  // Construction step 1a — boot convergence. Every `in_progress` row belongs to
  // an attempt this runtime cannot possibly still be making, and the invariant
  // that a pointer never coexists with `in_progress` is what makes that
  // unambiguous rather than a guess.
  const interrupted = yield* repository.failInterruptedAttempts;
  yield* Effect.forEach(interrupted, publishChanged, { discard: true });

  // Construction step 1b — release incarnations the runtime itself ended. A
  // Code Server that a shutdown or crash took down is not an outcome to show:
  // the context returns to idle, so the next open of its pane launches a fresh
  // incarnation through the ordinary `reuse` path, exactly as a first open
  // does. Nothing launches here — an editor starts only when its pane asks.
  // Every other ending (an exit, a kill, a failed launch) keeps its pointer and
  // stays visible with Retry. The process is terminal, so clearing ownership
  // here cannot orphan a live one.
  const holding = yield* repository.listHoldingIncarnation();
  for (const row of holding) {
    if (row.activePtyProcess === null || !interruptedByRuntime(row.activePtyProcess)) continue;
    const cleared = yield* repository.clearIncarnation(row.id);
    if (cleared === 'applied') yield* publishChanged(row.id);
  }

  // Construction step 2 — the single interpreter of editor PTY events. The
  // subscription is taken here, before the fork, so no event published after
  // construction is missed.
  const processEvents = yield* eventBus.subscribe([
    'pty_process_exited',
    'pty_process_failed',
    'pty_process_killed',
  ]);
  yield* Effect.forkScoped(
    processEvents.pipe(
      Stream.runForEach((event) =>
        handleProcessEvent(event).pipe(
          Effect.catch((error) =>
            Effect.logWarning('Editor PTY event handling failed').pipe(
              Effect.annotateLogs({ cause: describeOperationalCause(error) }),
            ),
          ),
        ),
      ),
    ),
  );

  return service;
});

export class EditorContextService extends Context.Service<
  EditorContextService,
  {
    /**
     * The Class C guard both operations call first, and the same one the palette's
     * availability path uses. A façade over provisioning on purpose: the editor
     * domain stays the single door, so no other layer has to learn how
     * provisioning models readiness.
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
>()('isagi/runtime/editor/EditorContextService') {
  static readonly layerNoDeps = Layer.effect(EditorContextService, make);
  static readonly layer = EditorContextService.layerNoDeps.pipe(
    Layer.provide([
      EditorContextRepository.layer,
      EditorProvisioning.layer,
      EntityLock.layer,
      InternalEvents.layer,
      LoopbackPortProbe.layer,
      ProjectRepository.layer,
      PtyService.layer,
    ]),
  );
}
