import { Effect } from 'effect';

import type { InternalRuntimeEventBusService } from '../../runtime-events/index.js';
import type { PtyRepositoryService } from '../pty.repository.js';
import type { PtyProcessStatusReason } from '../types.js';
import type { PtyExit } from '../types.js';
import type { ActiveAttachment } from './attachments.js';
import { transitionProcessByIdAndPublish } from './events.js';
import type { PtyRetryScheduler } from './retry.js';

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

// The poller's variant: same membership answer, plus the age report the fixed
// poll cadence makes meaningful.
export function skipReservedRow(
  reservations: PtyReservations,
  ptyProcessId: number,
  warnAfterMs: number,
) {
  const termination = reservations.terminations.get(ptyProcessId);
  if (termination) {
    warnOnceWhenStale(
      termination,
      warnAfterMs,
      (ageMs) =>
        `[runtime] PTY termination reservation is still unresolved ptyProcessId=${ptyProcessId} reason=${termination.reason} ownership=${termination.ownership} ageMs=${ageMs}`,
    );
    return true;
  }
  const launch = reservations.launches.get(ptyProcessId);
  if (launch) {
    warnOnceWhenStale(
      launch,
      warnAfterMs,
      (ageMs) =>
        `[runtime] PTY launch reservation is still unresolved ptyProcessId=${ptyProcessId} ageMs=${ageMs}`,
    );
    return true;
  }
  return false;
}

function warnOnceWhenStale(
  reservation: PtyReservationAge,
  warnAfterMs: number,
  message: (ageMs: number) => string,
) {
  const ageMs = Date.now() - reservation.reservedAt;
  if (ageMs <= warnAfterMs || reservation.ageWarningLogged) return;
  reservation.ageWarningLogged = true;
  console.warn(message(ageMs));
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
  repository: PtyRepositoryService,
  eventBus: InternalRuntimeEventBusService,
  retry: PtyRetryScheduler,
  activeAttachments: Map<number, ActiveAttachment>,
  terminations: PtyTerminations,
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
      console.info(
        `[runtime] Captured backend exit for terminating PTY ${ptyProcessId} reason=${termination.reason}`,
      );
      return;
    }
    yield* persistExit(repository, eventBus, retry, activeAttachments, ptyProcessId, exit);
  });
}

// Persist an exit that no termination attempt is reserving.
function persistExit(
  repository: PtyRepositoryService,
  eventBus: InternalRuntimeEventBusService,
  retry: PtyRetryScheduler,
  activeAttachments: Map<number, ActiveAttachment>,
  ptyProcessId: number,
  exit: PtyExit,
) {
  return persistExitOnce(repository, eventBus, activeAttachments, ptyProcessId, exit).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        console.error(`[runtime] Failed to persist PTY exit for session ${ptyProcessId}`, error);
        scheduleExitRetry(repository, eventBus, retry, activeAttachments, ptyProcessId, exit);
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
  repository: PtyRepositoryService,
  eventBus: InternalRuntimeEventBusService,
  retry: PtyRetryScheduler,
  activeAttachments: Map<number, ActiveAttachment>,
  terminations: PtyTerminations,
  ptyProcessId: number,
  termination: PtyTerminationState,
  exit: PtyExit,
) {
  return persistExitOnce(repository, eventBus, activeAttachments, ptyProcessId, exit).pipe(
    Effect.matchEffect({
      onSuccess: () =>
        Effect.sync(() => clearTerminationReservation(terminations, ptyProcessId, termination)),
      onFailure: (error) =>
        Effect.sync(() => {
          console.error(`[runtime] Failed to persist PTY exit for session ${ptyProcessId}`, error);
          transferTerminationToRetry(termination);
          scheduleExitRetry(
            repository,
            eventBus,
            retry,
            activeAttachments,
            ptyProcessId,
            exit,
            () => clearTerminationReservation(terminations, ptyProcessId, termination),
          );
        }),
    }),
  );
}

// The affirmative kill is real even while its write is deferred, so the row
// stays reserved until this retry lands or an already-terminal fact rejects it.
export function retryPersistKilledUntilSuccess(
  repository: PtyRepositoryService,
  eventBus: InternalRuntimeEventBusService,
  retry: PtyRetryScheduler,
  terminations: PtyTerminations,
  ptyProcessId: number,
  termination: PtyTerminationState,
) {
  transferTerminationToRetry(termination);
  const attempt: Effect.Effect<void> = Effect.suspend(() =>
    transitionProcessByIdAndPublish(repository, eventBus, {
      ptyProcessId,
      status: 'killed',
      statusReason: termination.reason,
      exitCode: null,
      signal: null,
    }).pipe(
      Effect.matchEffect({
        // A rejection by an already-terminal row resolves this retry just as a
        // successful write does: the durable fact is settled either way, so the
        // reservation must not outlive it.
        onSuccess: () =>
          Effect.sync(() => clearTerminationReservation(terminations, ptyProcessId, termination)),
        onFailure: (error) =>
          Effect.sync(() => {
            console.error(
              `[runtime] Failed to retry PTY termination persistence for session ${ptyProcessId}`,
              error,
            );
            retry.schedule(`killed ptyProcessId=${ptyProcessId}`, attempt);
          }),
      }),
    ),
  );

  retry.schedule(`killed ptyProcessId=${ptyProcessId}`, attempt);
}

function persistExitOnce(
  repository: PtyRepositoryService,
  eventBus: InternalRuntimeEventBusService,
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
      console.info(
        `[runtime] PTY exited ptyProcessId=${ptyProcessId} status=${status} exitCode=${exit.exitCode ?? 'null'} signal=${exit.signal ?? 'null'}`,
      );
    }
    return result;
  });
}

function scheduleExitRetry(
  repository: PtyRepositoryService,
  eventBus: InternalRuntimeEventBusService,
  retry: PtyRetryScheduler,
  activeAttachments: Map<number, ActiveAttachment>,
  ptyProcessId: number,
  exit: PtyExit,
  onResolved?: () => void,
) {
  const attempt: Effect.Effect<void> = Effect.suspend(() =>
    persistExitOnce(repository, eventBus, activeAttachments, ptyProcessId, exit).pipe(
      Effect.matchEffect({
        onSuccess: () => Effect.sync(() => onResolved?.()),
        onFailure: (error) =>
          Effect.sync(() => {
            console.error(
              `[runtime] Failed to retry PTY exit persistence for session ${ptyProcessId}`,
              error,
            );
            retry.schedule(`exit ptyProcessId=${ptyProcessId}`, attempt);
          }),
      }),
    ),
  );

  retry.schedule(`exit ptyProcessId=${ptyProcessId}`, attempt);
}
