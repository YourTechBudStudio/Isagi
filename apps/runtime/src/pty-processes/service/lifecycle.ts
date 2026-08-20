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
export interface PtyTerminationState {
  readonly reason: DurablePtyTerminationReason;
  readonly reservedAt: number;
  exit: PtyExit | null;
  ageWarningLogged: boolean;
  ownership: 'attempt' | 'retry' | 'released';
}

export type PtyTerminations = Map<number, PtyTerminationState>;

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
