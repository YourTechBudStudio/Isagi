import { Effect, FiberMap } from 'effect';

import { describeOperationalCause } from '../../platform/diagnostics/index.js';
import type { InternalEvents } from '../../platform/events/index.js';
import type { PtyRepository } from '../repository.js';
import type { PtyProcessStatusReason } from '../types.js';
import type { PtyExit } from '../types.js';
import type { ActiveAttachment } from './attachments.js';
import { transitionProcessByIdAndPublish } from './events.js';
import type { PtyPersistenceRetry } from './retry.js';

export type DurablePtyTerminationReason = Extract<
  PtyProcessStatusReason,
  'user_requested' | 'runtime_shutdown'
>;

// A committed termination attempt. While an entry exists for a PTY id the row is
// reserved: generic liveness observers must not assign it a competing outcome,
// because a demonstrable kill must not lose its meaning to whichever verdict
// happened to persist first.
//
// `ownership` names who is responsible for releasing the entry, and it is the
// reason release is never an unconditional `delete`. It starts on the attempt;
// if the attempt's terminal write cannot be persisted it transfers to the
// background retry, which holds the row reserved until that write finally
// applies or is rejected by an already-terminal fact.
export interface PtyTerminationState extends PtyReservationAge {
  readonly reason: DurablePtyTerminationReason;
  exit: PtyExit | null;
  ownership: 'attempt' | 'retry' | 'released';
}

export type PtyTerminations = Map<number, PtyTerminationState>;

// The allocation-to-process window. A row exists and is durably `starting`, but
// no backend process does yet, so a generic liveness observer inspecting it
// would conclude `missing` and — under terminal immutability — permanently
// fail a launch that is still perfectly in flight.
export type PtyLaunchReservationState = PtyReservationAge;

export type PtyLaunchReservations = Map<number, PtyLaunchReservationState>;

// The two windows are deliberately separate structures rather than one keyed
// entry: during an in-flight spawn's cancellation cleanup the same row is
// legitimately held by both at once — the launch reservation until `start`'s
// finalizer runs, and a termination reservation for the cleanup kill.
export interface PtyReservations {
  readonly terminations: PtyTerminations;
  readonly launches: PtyLaunchReservations;
}

// Age is diagnostic only. A reservation held by a genuinely in-flight kill, an
// unbounded persistence retry, or a hung spawn is correct, so it is never
// expired or stolen — only reported, and at most once per reservation so a sick
// database or a wedged backend cannot turn an observer into a log flood.
export interface PtyReservationAge {
  readonly reservedAt: number;
  ageWarningLogged: boolean;
}

// One membership question for every generic observer. `handleAttachFailure`
// uses this directly: unlike the poller it has no fixed cadence to bound a
// warning against, so logging there would make diagnostics depend on how often
// a user happens to try to attach.
export function isRowReserved(reservations: PtyReservations, ptyProcessId: number) {
  return reservations.terminations.has(ptyProcessId) || reservations.launches.has(ptyProcessId);
}

// One supervisor fiber per launched process, consuming its backend `events` (see `superviseProcess` in `launch.ts`).
// A supervisor leaves this map only when its events stream ends, and a stream ends only after the supervisor has
// handled `Exited` (or without one, when `kill`/`terminate` suppressed it and the killer owns the outcome).
export type PtySupervisors = FiberMap.FiberMap<number, void, never>;

// The exit-in-flight window. A backend learns about an exit in its own callback, stops reporting the process as live
// there, and only enqueues `Exited`; the row records it later. Until it does, the row still reads `running` while
// `inspect` answers `missing` and `attach` answers "not live", so a `missing` verdict is not evidence that the process
// vanished: the real exit (code, signal) is about to be recorded, and a generic
// `runtime_ephemeral_lost`/`backend_process_missing` written first would win permanently under terminal immutability.
//
// Two holders cover the window end to end, and the second takes over before the first lets go:
// - the row's supervisor, from the backend callback until it handles `Exited` and its stream ends;
// - `deferredWrites`, when the supervisor's exit write failed and it handed that write to the persistence retry. The
//   supervisor adds the id before its stream can end, and the retry removes it once the write applies or is rejected
//   by an already-terminal row. A retry abandoned at shutdown leaves its id behind, like a termination reservation
//   left to a retry does; the service is closing, and the next startup reconciles the row.
export interface PtyPendingExits {
  readonly supervisors: PtySupervisors;
  readonly deferredWrites: PtyDeferredExitWrites;
}

export type PtyDeferredExitWrites = Set<number>;

// Only the `missing` verdict defers to a pending exit: the poller still reconciles a supervised row whose backend
// answers `alive`.
export function isExitPending(pendingExits: PtyPendingExits, ptyProcessId: number) {
  return (
    FiberMap.hasUnsafe(pendingExits.supervisors, ptyProcessId) ||
    pendingExits.deferredWrites.has(ptyProcessId)
  );
}

// The poller's variant: same membership answer, plus the age report the fixed
// poll cadence makes meaningful.
export function skipReservedRow(
  reservations: PtyReservations,
  ptyProcessId: number,
  warnAfterMs: number,
): Effect.Effect<boolean> {
  return Effect.suspend(() => {
    const termination = reservations.terminations.get(ptyProcessId);
    if (termination) {
      return warnOnceWhenStale(termination, warnAfterMs, (ageMs) =>
        Effect.logWarning('PTY termination reservation is still unresolved').pipe(
          Effect.annotateLogs({
            ptyProcessId,
            reason: termination.reason,
            ownership: termination.ownership,
            ageMs,
          }),
        ),
      ).pipe(Effect.as(true));
    }
    const launch = reservations.launches.get(ptyProcessId);
    if (launch) {
      return warnOnceWhenStale(launch, warnAfterMs, (ageMs) =>
        Effect.logWarning('PTY launch reservation is still unresolved').pipe(
          Effect.annotateLogs({ ptyProcessId, ageMs }),
        ),
      ).pipe(Effect.as(true));
    }
    return Effect.succeed(false);
  });
}

function warnOnceWhenStale(
  reservation: PtyReservationAge,
  warnAfterMs: number,
  warn: (ageMs: number) => Effect.Effect<void>,
) {
  return Effect.suspend(() => {
    const ageMs = Date.now() - reservation.reservedAt;
    if (ageMs <= warnAfterMs || reservation.ageWarningLogged) return Effect.void;
    reservation.ageWarningLogged = true;
    return warn(ageMs);
  });
}

// Reserve the allocation window. Called from inside the repository's insert
// transaction, so the reservation and the row become visible together.
export function reserveLaunch(launches: PtyLaunchReservations, ptyProcessId: number) {
  const reservation: PtyLaunchReservationState = {
    reservedAt: Date.now(),
    ageWarningLogged: false,
  };
  launches.set(ptyProcessId, reservation);
  return reservation;
}

// Identity-agnostic on purpose: unlike a termination, a launch reservation has
// exactly one owner for its whole lifetime (acquisition compensation before the
// allocation exists, then `start`'s finalizer or `abandon`), so there is no
// successor entry a late release could erase.
export function releaseLaunch(launches: PtyLaunchReservations, ptyProcessId: number) {
  launches.delete(ptyProcessId);
}

// Reserve the row for one attempt. A synchronous check-and-set with no
// intervening suspension point, so two concurrent callers cannot both win and
// the loser can be rejected before it decodes, probes, detaches, or touches the
// backend. Returns `null` when an attempt is already in flight.
export function reservePtyTermination(
  terminations: PtyTerminations,
  ptyProcessId: number,
  reason: DurablePtyTerminationReason,
): PtyTerminationState | null {
  if (terminations.has(ptyProcessId)) return null;
  const termination: PtyTerminationState = {
    reason,
    reservedAt: Date.now(),
    exit: null,
    ageWarningLogged: false,
    ownership: 'attempt',
  };
  terminations.set(ptyProcessId, termination);
  return termination;
}

// Release from the attempt. A no-op once ownership has moved to a persistence
// retry, so a finalizer can run unconditionally without erasing a reservation
// that is still protecting an unresolved terminal write.
export function releaseTerminationFromAttempt(
  terminations: PtyTerminations,
  ptyProcessId: number,
  termination: PtyTerminationState,
) {
  if (termination.ownership !== 'attempt') return;
  clearTerminationReservation(terminations, ptyProcessId, termination);
}

function transferTerminationToRetry(termination: PtyTerminationState) {
  termination.ownership = 'retry';
}

// Identity-aware: only ever removes this attempt's own entry. Collision
// prevention should make a stale closure unreachable, but a stale closure must
// never be able to unreserve a successor's row.
function clearTerminationReservation(
  terminations: PtyTerminations,
  ptyProcessId: number,
  termination: PtyTerminationState,
) {
  termination.ownership = 'released';
  if (terminations.get(ptyProcessId) === termination) {
    terminations.delete(ptyProcessId);
  }
}

export function handleExit(
  repository: PtyRepository['Service'],
  eventBus: InternalEvents['Service'],
  retry: PtyPersistenceRetry,
  activeAttachments: Map<number, ActiveAttachment>,
  terminations: PtyTerminations,
  deferredExitWrites: PtyDeferredExitWrites,
  ptyProcessId: number,
  exit: PtyExit,
) {
  return Effect.gen(function* () {
    const termination = terminations.get(ptyProcessId);
    if (termination) {
      // Captured, not persisted: the attempt that reserved this row owns the
      // terminal fact and decides whether this exit is independent evidence or
      // the consequence of its own affirmative kill.
      termination.exit = exit;
      activeAttachments.delete(ptyProcessId);
      yield* Effect.logInfo('Captured backend exit for terminating PTY').pipe(
        Effect.annotateLogs({ ptyProcessId, reason: termination.reason }),
      );
      return;
    }
    yield* persistExit(
      repository,
      eventBus,
      retry,
      activeAttachments,
      deferredExitWrites,
      ptyProcessId,
      exit,
    );
  });
}

// Persist an exit that no termination attempt is reserving. If the first write fails, the exit stays pending
// (`deferredExitWrites`) until the retry settles it: the supervisor running this ends as soon as the retry is
// submitted, and without the entry an observer could relabel the clean exit as a generic `missing` failure in the
// retry window — the same window `persistCapturedExitAndRelease` closes with its reservation.
function persistExit(
  repository: PtyRepository['Service'],
  eventBus: InternalEvents['Service'],
  retry: PtyPersistenceRetry,
  activeAttachments: Map<number, ActiveAttachment>,
  deferredExitWrites: PtyDeferredExitWrites,
  ptyProcessId: number,
  exit: PtyExit,
) {
  const settle = Effect.sync(() => {
    deferredExitWrites.delete(ptyProcessId);
  });
  return persistExitOnce(repository, eventBus, activeAttachments, ptyProcessId, exit).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        deferredExitWrites.add(ptyProcessId);
        yield* logPersistFailure('Failed to persist PTY exit', ptyProcessId, error);
        yield* retry.submit(
          `exit ptyProcessId=${ptyProcessId}`,
          persistExitOnce(repository, eventBus, activeAttachments, ptyProcessId, exit).pipe(
            Effect.andThen(settle),
          ),
        );
      }),
    ),
    Effect.asVoid,
  );
}

// Persist an exit captured while this attempt held the reservation. The entry
// stays held until the exit fact durably applies or is rejected, so the poller
// cannot relabel a clean independent exit as a generic `backend_process_missing`
// failure in the retry window — under terminal immutability that mislabel would
// be permanent.
export function persistCapturedExitAndRelease(
  repository: PtyRepository['Service'],
  eventBus: InternalEvents['Service'],
  retry: PtyPersistenceRetry,
  activeAttachments: Map<number, ActiveAttachment>,
  terminations: PtyTerminations,
  ptyProcessId: number,
  termination: PtyTerminationState,
  exit: PtyExit,
) {
  const release = Effect.sync(() =>
    clearTerminationReservation(terminations, ptyProcessId, termination),
  );
  return persistExitOnce(repository, eventBus, activeAttachments, ptyProcessId, exit).pipe(
    Effect.matchEffect({
      onSuccess: () => release,
      onFailure: (error) =>
        Effect.gen(function* () {
          yield* logPersistFailure('Failed to persist PTY exit', ptyProcessId, error);
          transferTerminationToRetry(termination);
          yield* retry.submit(
            `exit ptyProcessId=${ptyProcessId}`,
            persistExitOnce(repository, eventBus, activeAttachments, ptyProcessId, exit).pipe(
              Effect.andThen(release),
            ),
          );
        }),
    }),
  );
}

// The affirmative kill is real even while its write is deferred, so the row
// stays reserved until this retry lands or an already-terminal fact rejects it.
export function retryPersistKilledUntilSuccess(
  repository: PtyRepository['Service'],
  eventBus: InternalEvents['Service'],
  retry: PtyPersistenceRetry,
  terminations: PtyTerminations,
  ptyProcessId: number,
  termination: PtyTerminationState,
) {
  return Effect.suspend(() => {
    transferTerminationToRetry(termination);
    return retry.submit(
      `killed ptyProcessId=${ptyProcessId}`,
      transitionProcessByIdAndPublish(repository, eventBus, {
        ptyProcessId,
        status: 'killed',
        statusReason: termination.reason,
        exitCode: null,
        signal: null,
      }).pipe(
        // A rejection by an already-terminal row resolves this retry just as a
        // successful write does: the durable fact is settled either way, so the
        // reservation must not outlive it.
        Effect.andThen(
          Effect.sync(() => clearTerminationReservation(terminations, ptyProcessId, termination)),
        ),
      ),
    );
  });
}

function persistExitOnce(
  repository: PtyRepository['Service'],
  eventBus: InternalEvents['Service'],
  activeAttachments: Map<number, ActiveAttachment>,
  ptyProcessId: number,
  exit: PtyExit,
) {
  return Effect.gen(function* () {
    const status = exit.exitCode === 0 && exit.signal === null ? 'exited' : 'failed';
    activeAttachments.delete(ptyProcessId);
    const result = yield* transitionProcessByIdAndPublish(repository, eventBus, {
      ptyProcessId,
      status,
      statusReason: null,
      exitCode: exit.exitCode,
      signal: exit.signal,
    });
    // A late callback for a row whose terminal fact already landed cleans up its
    // attachment but announces nothing — logging a competing outcome would read
    // as a second death.
    if (result.applied) {
      yield* Effect.logInfo('PTY exited').pipe(
        Effect.annotateLogs({
          ptyProcessId,
          status,
          exitCode: exit.exitCode ?? 'null',
          signal: exit.signal ?? 'null',
        }),
      );
    }
    return result;
  });
}

function logPersistFailure(message: string, ptyProcessId: number, error: unknown) {
  return Effect.logWarning(message).pipe(
    Effect.annotateLogs({ ptyProcessId, cause: describeOperationalCause(error) }),
  );
}
