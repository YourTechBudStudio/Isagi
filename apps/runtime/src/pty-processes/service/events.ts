import { Effect } from 'effect';

import type { InternalRuntimeEventBusService } from '../../runtime-events/index.js';
import type { PtyForegroundStateService } from '../foreground-state.js';
import type { PtyProcessTransitionResult, PtyRepositoryService } from '../pty.repository.js';
import type { PtyProcessRecord } from '../types.js';
import type {
  PtyForegroundCommandState,
  PtyProcessStatus,
  PtyProcessStatusReason,
} from '../types.js';

export interface PtyProcessTransitionInput {
  readonly ptyProcessId: number;
  readonly status: PtyProcessStatus;
  readonly statusReason?: PtyProcessStatusReason | null | undefined;
  readonly exitCode?: number | null | undefined;
  readonly signal?: string | null | undefined;
  readonly lastSeenAt?: string | null | undefined;
}

// A lifecycle event is published only when the write durably `applied` **and**
// materially changed the row. Both halves matter: PTY events are shared facts
// other domains derive process state from, so a rejected write must be
// observably a no-op rather than an announcement of a status that never landed.
export function transitionProcessAndPublish(
  repository: PtyRepositoryService,
  eventBus: InternalRuntimeEventBusService,
  previous: PtyProcessRecord,
  input: PtyProcessTransitionInput,
) {
  return Effect.gen(function* () {
    const result = yield* repository.transitionProcess(input);
    yield* publishAppliedTransition(eventBus, previous, input, result);
    return result;
  });
}

export function transitionProcessByIdAndPublish(
  repository: PtyRepositoryService,
  eventBus: InternalRuntimeEventBusService,
  input: PtyProcessTransitionInput,
) {
  return Effect.gen(function* () {
    const previous = yield* repository.findProcess(input.ptyProcessId);
    const result = yield* repository.transitionProcess(input);
    if (previous) {
      yield* publishAppliedTransition(eventBus, previous, input, result);
    }
    return result;
  });
}

function publishAppliedTransition(
  eventBus: InternalRuntimeEventBusService,
  previous: PtyProcessRecord,
  input: PtyProcessTransitionInput,
  result: PtyProcessTransitionResult,
) {
  if (!result.applied) return Effect.void;
  return publishPtyProcessChangedIfNeeded(eventBus, previous, {
    status: input.status,
    statusReason: input.statusReason ?? null,
    exitCode: input.exitCode ?? previous.exitCode,
    signal: input.signal ?? previous.signal,
  });
}

function publishPtyProcessChangedIfNeeded(
  eventBus: InternalRuntimeEventBusService,
  previous: PtyProcessRecord,
  next: {
    readonly status: PtyProcessStatus;
    readonly statusReason: PtyProcessStatusReason | null;
    readonly exitCode: number | null;
    readonly signal: string | null;
  },
) {
  if (previous.status === next.status && previous.statusReason === next.statusReason) {
    return Effect.void;
  }

  if (next.status === 'running' || next.status === 'starting') {
    return eventBus.publish({
      type: 'pty_process_started',
      ptyProcessId: previous.id,
      status: next.status,
    });
  }
  if (next.status === 'killed') {
    return eventBus.publish({
      type: 'pty_process_killed',
      ptyProcessId: previous.id,
      status: next.status,
      statusReason: next.statusReason,
    });
  }
  if (next.status === 'exited') {
    return eventBus.publish({
      type: 'pty_process_exited',
      ptyProcessId: previous.id,
      status: next.status,
      exitCode: next.exitCode,
      signal: next.signal,
    });
  }
  return eventBus.publish({
    type: 'pty_process_failed',
    ptyProcessId: previous.id,
    status: next.status,
    statusReason: next.statusReason,
  });
}

// Shared by the launch path and the attach path, which both receive foreground
// notifications from a backend and must announce only real changes.
export function recordForegroundCommandState(
  foreground: PtyForegroundStateService,
  eventBus: InternalRuntimeEventBusService,
  ptyProcessId: number,
  state: PtyForegroundCommandState,
) {
  return foreground.set(ptyProcessId, state).pipe(
    Effect.flatMap((changed) =>
      changed
        ? eventBus.publish({
            type:
              state === 'working'
                ? 'pty_foreground_command_started'
                : 'pty_foreground_command_ended',
            ptyProcessId,
          })
        : Effect.void,
    ),
  );
}
