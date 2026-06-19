import { Effect, Either } from 'effect';

import type { InternalRuntimeEventBusService } from '../../runtime-events/index.js';
import type { PtyProcessRecord } from '../../surfaces/index.js';
import type { PtyRepositoryService } from '../pty.repository.js';
import type { PtyProcessStatusReason } from '../types.js';
import { PtyServiceError, type PtyBackend } from '../types.js';
import type { ActiveAttachment } from './attachments.js';
import { detachActiveAttachment } from './attachments.js';
import { decodeBackendRef } from './backend-ref.js';
import { transitionProcessAndPublish } from './events.js';
import {
  persistExit,
  retryPersistKilledUntilSuccess,
  type PtyTerminationState,
} from './lifecycle.js';

export type DurablePtyTerminationReason = Extract<
  PtyProcessStatusReason,
  'user_requested' | 'runtime_shutdown'
>;

export function terminatePtyProcessAndPersistKilled(input: {
  readonly repository: PtyRepositoryService;
  readonly backend: PtyBackend;
  readonly eventBus: InternalRuntimeEventBusService;
  readonly activeAttachments: Map<number, ActiveAttachment>;
  readonly terminations: Map<number, PtyTerminationState>;
  readonly ptyProcessId: number;
  readonly reason: DurablePtyTerminationReason;
  readonly gracefulTimeoutMs?: number | undefined;
  readonly killFailurePolicy?: 'fail' | 'persist_killed';
}) {
  return Effect.gen(function* () {
    const session = yield* findPtyProcessOrFail(input.repository, input.ptyProcessId);
    const ref = yield* decodeBackendRef(session);
    if (session.backend !== input.backend.name) {
      return yield* Effect.fail(
        new PtyServiceError({
          code: 'backend_unavailable',
          message: `PTY backend ${session.backend} is not active in this runtime process.`,
          ptyProcessId: session.id,
        }),
      );
    }

    const termination = beginPtyTermination(input.terminations, session.id, {
      reason: input.reason,
    });
    yield* detachActiveAttachment(input.activeAttachments, session.id);

    const killResult = yield* (
      input.backend.terminate
        ? input.backend.terminate({
            ref,
            gracefulTimeoutMs: input.gracefulTimeoutMs ?? 2_000,
          })
        : input.backend.kill(ref)
    ).pipe(Effect.either);
    if (Either.isLeft(killResult)) {
      if (input.killFailurePolicy === 'persist_killed') {
        console.warn(
          `[runtime] PTY backend termination failed; persisting terminal state ptyProcessId=${session.id} reason=${input.reason}`,
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
      `[runtime] PTY process terminated ptyProcessId=${session.id} reason=${input.reason} outcome=persist_killed`,
    );
  });
}

function findPtyProcessOrFail(repository: PtyRepositoryService, ptyProcessId: number) {
  return Effect.gen(function* () {
    const session = yield* repository.findProcess(ptyProcessId);
    if (!session) {
      return yield* Effect.fail(
        new PtyServiceError({
          code: 'session_not_found',
          message: `PTY process ${ptyProcessId} was not found.`,
          ptyProcessId,
        }),
      );
    }
    return session;
  });
}

function beginPtyTermination(
  terminations: Map<number, PtyTerminationState>,
  ptyProcessId: number,
  input: {
    readonly reason: DurablePtyTerminationReason;
  },
) {
  const termination: PtyTerminationState = {
    completed: false,
    exit: null,
    reason: input.reason,
    outcome: 'persist_killed',
  };
  terminations.set(ptyProcessId, termination);
  return termination;
}

function persistKilledTransition(
  input: {
    readonly repository: PtyRepositoryService;
    readonly eventBus: InternalRuntimeEventBusService;
    readonly reason: DurablePtyTerminationReason;
  },
  session: PtyProcessRecord,
) {
  return transitionProcessAndPublish(input.repository, input.eventBus, session, {
    ptyProcessId: session.id,
    status: 'killed',
    statusReason: input.reason,
    exitCode: null,
    signal: null,
  });
}

function completePtyTermination(
  terminations: Map<number, PtyTerminationState>,
  session: PtyProcessRecord,
  termination: PtyTerminationState,
) {
  termination.completed = true;
  if (session.backend === 'tmux' || termination.exit) {
    terminations.delete(session.id);
  }
}
