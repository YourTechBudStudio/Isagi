import { Effect } from 'effect';

import type { InternalRuntimeEventBusService } from '../../runtime-events/index.js';
import type { PtyProcessRecord } from '../../surfaces/index.js';
import type { PtyRepositoryService } from '../pty.repository.js';
import type { PtyProcessStatus, PtyProcessStatusReason } from '../types.js';

export interface PtyProcessTransitionInput {
  readonly ptyProcessId: number;
  readonly status: PtyProcessStatus;
  readonly statusReason?: PtyProcessStatusReason | null | undefined;
  readonly exitCode?: number | null | undefined;
  readonly signal?: string | null | undefined;
  readonly lastSeenAt?: string | null | undefined;
}

export function transitionProcessAndPublish(
  repository: PtyRepositoryService,
  eventBus: InternalRuntimeEventBusService,
  previous: PtyProcessRecord,
  input: PtyProcessTransitionInput,
) {
  return repository.transitionProcess(input).pipe(
    Effect.zipRight(
      publishPtyProcessChangedIfNeeded(eventBus, previous, {
        status: input.status,
        statusReason: input.statusReason ?? null,
        exitCode: input.exitCode ?? previous.exitCode,
        signal: input.signal ?? previous.signal,
      }),
    ),
  );
}

export function transitionProcessByIdAndPublish(
  repository: PtyRepositoryService,
  eventBus: InternalRuntimeEventBusService,
  input: PtyProcessTransitionInput,
) {
  return Effect.gen(function* () {
    const previous = yield* repository.findProcess(input.ptyProcessId);
    yield* repository.transitionProcess(input);
    if (previous) {
      yield* publishPtyProcessChangedIfNeeded(eventBus, previous, {
        status: input.status,
        statusReason: input.statusReason ?? null,
        exitCode: input.exitCode ?? previous.exitCode,
        signal: input.signal ?? previous.signal,
      });
    }
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
