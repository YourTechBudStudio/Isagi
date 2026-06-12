import { Effect } from 'effect';

import type { PtySessionStatus, PtySessionStatusReason } from '@isagi/contracts';

import {
  nextRuntimeEventEnvelope,
  type RuntimeEventBusService,
} from '../../runtime-events/index.js';
import type { PtySessionRow } from '../../surfaces/index.js';
import type { PtyRepositoryService } from '../pty.repository.js';

export interface PtySessionTransitionInput {
  readonly ptySessionId: number;
  readonly status: PtySessionStatus;
  readonly statusReason?: PtySessionStatusReason | null | undefined;
  readonly exitCode?: number | null | undefined;
  readonly signal?: string | null | undefined;
  readonly lastSeenAt?: string | null | undefined;
}

export function transitionSessionAndPublish(
  repository: PtyRepositoryService,
  eventBus: RuntimeEventBusService,
  previous: PtySessionRow,
  input: PtySessionTransitionInput,
) {
  return repository.transitionSession(input).pipe(
    Effect.zipRight(
      publishPtySessionChangedIfNeeded(eventBus, previous, {
        status: input.status,
        statusReason: input.statusReason ?? null,
      }),
    ),
  );
}

export function transitionSessionByIdAndPublish(
  repository: PtyRepositoryService,
  eventBus: RuntimeEventBusService,
  input: PtySessionTransitionInput,
) {
  return Effect.gen(function* () {
    const previous = yield* repository.findSession(input.ptySessionId);
    yield* repository.transitionSession(input);
    if (previous) {
      yield* publishPtySessionChangedIfNeeded(eventBus, previous, {
        status: input.status,
        statusReason: input.statusReason ?? null,
      });
    }
  });
}

function publishPtySessionChangedIfNeeded(
  eventBus: RuntimeEventBusService,
  previous: PtySessionRow,
  next: {
    readonly status: PtySessionStatus;
    readonly statusReason: PtySessionStatusReason | null;
  },
) {
  if (previous.status === next.status && previous.statusReason === next.statusReason) {
    return Effect.void;
  }

  return eventBus.publish({
    ...nextRuntimeEventEnvelope(),
    type: 'pty_session_changed',
    payload: {
      ptySessionId: previous.id,
      worktreeId: previous.worktreeId,
      surfaceId: previous.surfaceId,
      paneId: previous.paneId,
      previousStatus: previous.status,
      status: next.status,
      previousStatusReason: previous.statusReason,
      statusReason: next.statusReason,
    },
  });
}
