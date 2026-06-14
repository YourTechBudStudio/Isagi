import { Effect } from 'effect';

import type { PtySessionStatusReason } from '@isagi/contracts';

import type { RuntimeEventBusService } from '../../runtime-events/index.js';
import type { PtySessionRow } from '../../surfaces/index.js';
import type { PtyRepositoryService } from '../pty.repository.js';
import type { PtyExit } from '../types.js';
import type { ActiveAttachment } from './attachments.js';
import { transitionSessionAndPublish, transitionSessionByIdAndPublish } from './events.js';

export interface PtyTerminationState {
  completed: boolean;
  exit: PtyExit | null;
  reason: Extract<PtySessionStatusReason, 'user_requested' | 'runtime_shutdown'>;
  outcome: 'persist_killed' | 'delete_session';
}

export function handleExit(
  repository: PtyRepositoryService,
  eventBus: RuntimeEventBusService,
  activeAttachments: Map<number, ActiveAttachment>,
  terminations: Map<number, PtyTerminationState>,
  ptySessionId: number,
  exit: PtyExit,
) {
  return Effect.gen(function* () {
    const termination = terminations.get(ptySessionId);
    if (termination) {
      termination.exit = exit;
      activeAttachments.delete(ptySessionId);
      console.info(
        `[runtime] Ignoring backend exit for terminating PTY ${ptySessionId} reason=${termination.reason} outcome=${termination.outcome}`,
      );
      if (termination.completed) {
        terminations.delete(ptySessionId);
      }
      return;
    }
    yield* persistExit(repository, eventBus, activeAttachments, ptySessionId, exit);
  });
}

export function persistExit(
  repository: PtyRepositoryService,
  eventBus: RuntimeEventBusService,
  activeAttachments: Map<number, ActiveAttachment>,
  ptySessionId: number,
  exit: PtyExit,
) {
  return persistExitOnce(repository, eventBus, activeAttachments, ptySessionId, exit).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        console.error(`[runtime] Failed to persist PTY exit for session ${ptySessionId}`, error);
        retryPersistExitUntilSuccess(repository, eventBus, activeAttachments, ptySessionId, exit);
      }),
    ),
  );
}

export function retryPersistKilledUntilSuccess(
  repository: PtyRepositoryService,
  eventBus: RuntimeEventBusService,
  terminations: Map<number, PtyTerminationState>,
  termination: PtyTerminationState,
  backend: PtySessionRow['backend'],
  ptySessionId: number,
) {
  const retry = () => {
    void Effect.runPromise(
      repository
        .findSession(ptySessionId)
        .pipe(
          Effect.flatMap((session) =>
            session
              ? transitionSessionAndPublish(repository, eventBus, session, {
                  ptySessionId,
                  status: 'killed',
                  statusReason: termination.reason,
                  exitCode: null,
                  signal: null,
                })
              : transitionSessionByIdAndPublish(repository, eventBus, {
                  ptySessionId,
                  status: 'killed',
                  statusReason: termination.reason,
                  exitCode: null,
                  signal: null,
                }),
          ),
        )
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              termination.completed = true;
              if (backend === 'tmux' || termination.exit) {
                terminations.delete(ptySessionId);
              }
            }),
          ),
          Effect.catchAll((error) =>
            Effect.sync(() => {
              console.error(
                `[runtime] Failed to retry PTY termination persistence for session ${ptySessionId}`,
                error,
              );
              setTimeout(retry, 1_000);
            }),
          ),
        ),
    );
  };

  setTimeout(retry, 1_000);
}

function persistExitOnce(
  repository: PtyRepositoryService,
  eventBus: RuntimeEventBusService,
  activeAttachments: Map<number, ActiveAttachment>,
  ptySessionId: number,
  exit: PtyExit,
) {
  return Effect.gen(function* () {
    const status = exit.exitCode === 0 && exit.signal === null ? 'exited' : 'failed';
    console.info(
      `[runtime] PTY exited ptySessionId=${ptySessionId} status=${status} exitCode=${exit.exitCode ?? 'null'} signal=${exit.signal ?? 'null'}`,
    );
    activeAttachments.delete(ptySessionId);
    yield* transitionSessionByIdAndPublish(repository, eventBus, {
      ptySessionId,
      status,
      statusReason: null,
      exitCode: exit.exitCode,
      signal: exit.signal,
    });
  });
}

function retryPersistExitUntilSuccess(
  repository: PtyRepositoryService,
  eventBus: RuntimeEventBusService,
  activeAttachments: Map<number, ActiveAttachment>,
  ptySessionId: number,
  exit: PtyExit,
) {
  const retry = () => {
    void Effect.runPromise(
      persistExitOnce(repository, eventBus, activeAttachments, ptySessionId, exit).pipe(
        Effect.catchAll((error) =>
          Effect.sync(() => {
            console.error(
              `[runtime] Failed to retry PTY exit persistence for session ${ptySessionId}`,
              error,
            );
            setTimeout(retry, 1_000);
          }),
        ),
      ),
    );
  };

  setTimeout(retry, 1_000);
}
