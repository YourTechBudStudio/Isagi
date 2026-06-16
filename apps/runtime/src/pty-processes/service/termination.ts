import { Effect, Either } from 'effect';

import type { SurfaceDeleteWarning } from '@isagi/contracts';

import type { InternalRuntimeEventBusService } from '../../runtime-events/index.js';
import type { PtySessionRow } from '../../surfaces/index.js';
import type { PtyRepositoryService } from '../pty.repository.js';
import type { PtySessionStatusReason } from '../types.js';
import { PtyServiceError, type BackendSessionRef, type PtyBackend } from '../types.js';
import type { ActiveAttachment } from './attachments.js';
import { detachActiveAttachment } from './attachments.js';
import { decodeBackendRef } from './backend-ref.js';
import { transitionSessionAndPublish } from './events.js';
import {
  persistExit,
  retryPersistKilledUntilSuccess,
  type PtyTerminationState,
} from './lifecycle.js';

export type DurablePtyTerminationReason = Extract<
  PtySessionStatusReason,
  'user_requested' | 'runtime_shutdown'
>;

export type PtyTerminationOutcome = 'persist_killed' | 'delete_session';

export function terminatePtySessionAndPersistKilled(input: {
  readonly repository: PtyRepositoryService;
  readonly backend: PtyBackend;
  readonly eventBus: InternalRuntimeEventBusService;
  readonly activeAttachments: Map<number, ActiveAttachment>;
  readonly terminations: Map<number, PtyTerminationState>;
  readonly ptySessionId: number;
  readonly reason: DurablePtyTerminationReason;
  readonly killFailurePolicy?: 'fail' | 'persist_killed';
}) {
  return Effect.gen(function* () {
    const session = yield* findPtySessionOrFail(input.repository, input.ptySessionId);
    const ref = yield* decodeBackendRef(session);
    if (session.backend !== input.backend.name) {
      return yield* Effect.fail(
        new PtyServiceError({
          code: 'backend_unavailable',
          message: `PTY backend ${session.backend} is not active in this runtime process.`,
          ptySessionId: session.id,
        }),
      );
    }

    const termination = beginPtyTermination(input.terminations, session.id, {
      reason: input.reason,
      outcome: 'persist_killed',
    });
    yield* detachActiveAttachment(input.activeAttachments, session.id);

    const killResult = yield* input.backend.kill(ref).pipe(Effect.either);
    if (Either.isLeft(killResult)) {
      if (input.killFailurePolicy === 'persist_killed') {
        console.warn(
          `[runtime] PTY backend termination failed; persisting terminal state ptySessionId=${session.id} reason=${input.reason}`,
          killResult.left,
        );
      } else {
        input.terminations.delete(session.id);
        if (termination.exit) {
          yield* persistExit(
            input.repository,
            input.eventBus,
            input.activeAttachments,
            session.id,
            termination.exit,
          );
        }
        return yield* Effect.fail(killResult.left);
      }
    }

    const transitionResult = yield* persistKilledTransition(input, session).pipe(Effect.either);
    if (Either.isLeft(transitionResult)) {
      retryPersistKilledUntilSuccess(
        input.repository,
        input.eventBus,
        input.terminations,
        termination,
        session.backend,
        session.id,
      );
      return yield* Effect.fail(transitionResult.left);
    }

    completePtyTermination(input.terminations, session, termination);
    console.info(
      `[runtime] PTY session terminated ptySessionId=${session.id} reason=${input.reason} outcome=persist_killed`,
    );
  });
}

export function terminatePtySessionForDelete(input: {
  readonly repository: PtyRepositoryService;
  readonly backend: PtyBackend;
  readonly eventBus: InternalRuntimeEventBusService;
  readonly activeAttachments: Map<number, ActiveAttachment>;
  readonly terminations: Map<number, PtyTerminationState>;
  readonly ptySessionId: number;
  readonly paneId: number;
  readonly session: SurfaceDeleteWarning['session'];
}) {
  return Effect.gen(function* () {
    const session = yield* input.repository.findSession(input.ptySessionId);
    if (!session || (session.status !== 'starting' && session.status !== 'running')) {
      return [];
    }

    if (session.backend !== input.backend.name) {
      return [deleteCleanupWarning('session_process_cleanup_failed', input.paneId, input.session)];
    }

    const ref = yield* decodeBackendRef(session).pipe(
      Effect.catchAll(() => Effect.succeed<BackendSessionRef | null>(null)),
    );
    if (!ref) {
      return [deleteCleanupWarning('session_process_cleanup_failed', input.paneId, input.session)];
    }

    yield* detachActiveAttachment(input.activeAttachments, session.id);
    const inspection = yield* input.backend
      .inspect(ref)
      .pipe(Effect.catchAll(() => Effect.succeed({ status: 'unavailable' as const })));
    if (inspection.status === 'missing') {
      return [];
    }
    if (inspection.status === 'unavailable') {
      // Immediate cleanup could not happen in this runtime process. The
      // durable row is still deleted by SurfaceService; backend GC can
      // retry orphan cleanup later when the relevant backend is available.
      return [deleteCleanupWarning('session_process_cleanup_failed', input.paneId, input.session)];
    }

    const termination = beginPtyTermination(input.terminations, session.id, {
      reason: 'user_requested',
      outcome: 'delete_session',
    });
    const killResult = yield* input.backend.kill(ref).pipe(Effect.either);
    if (Either.isLeft(killResult)) {
      input.terminations.delete(session.id);
      console.warn(
        `[runtime] PTY delete cleanup could not terminate backend session ptySessionId=${session.id}`,
        killResult.left,
      );
      return [deleteCleanupWarning('session_process_cleanup_failed', input.paneId, input.session)];
    }

    termination.completed = true;
    input.terminations.delete(session.id);
    yield* input.eventBus.publish({
      type: 'pty_process_killed',
      ptyProcessId: session.id,
      status: 'killed',
      statusReason: 'user_requested',
    });
    console.info(
      `[runtime] PTY session terminated for delete ptySessionId=${session.id} reason=user_requested outcome=delete_session`,
    );
    return [];
  });
}

function findPtySessionOrFail(repository: PtyRepositoryService, ptySessionId: number) {
  return Effect.gen(function* () {
    const session = yield* repository.findSession(ptySessionId);
    if (!session) {
      return yield* Effect.fail(
        new PtyServiceError({
          code: 'session_not_found',
          message: `PTY session ${ptySessionId} was not found.`,
          ptySessionId,
        }),
      );
    }
    return session;
  });
}

function beginPtyTermination(
  terminations: Map<number, PtyTerminationState>,
  ptySessionId: number,
  input: {
    readonly reason: DurablePtyTerminationReason;
    readonly outcome: PtyTerminationOutcome;
  },
) {
  const termination: PtyTerminationState = {
    completed: false,
    exit: null,
    reason: input.reason,
    outcome: input.outcome,
  };
  terminations.set(ptySessionId, termination);
  return termination;
}

function persistKilledTransition(
  input: {
    readonly repository: PtyRepositoryService;
    readonly eventBus: InternalRuntimeEventBusService;
    readonly reason: DurablePtyTerminationReason;
  },
  session: PtySessionRow,
) {
  return transitionSessionAndPublish(input.repository, input.eventBus, session, {
    ptySessionId: session.id,
    status: 'killed',
    statusReason: input.reason,
    exitCode: null,
    signal: null,
  });
}

function completePtyTermination(
  terminations: Map<number, PtyTerminationState>,
  session: PtySessionRow,
  termination: PtyTerminationState,
) {
  termination.completed = true;
  if (session.backend === 'tmux' || termination.exit) {
    terminations.delete(session.id);
  }
}

function deleteCleanupWarning(
  code: SurfaceDeleteWarning['code'],
  paneId: number,
  session: SurfaceDeleteWarning['session'],
): SurfaceDeleteWarning {
  return { code, paneId, session };
}
