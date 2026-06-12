import { Effect } from 'effect';

import type { RuntimeEventBusService } from '../../runtime-events/index.js';
import type { PtySessionRow } from '../../surfaces/index.js';
import type { PtyRepositoryService } from '../pty.repository.js';
import type { PtyExit } from '../types.js';
import type { ActiveAttachment } from './attachments.js';
import { transitionSessionAndPublish, transitionSessionByIdAndPublish } from './events.js';

export interface IntentionalKillState {
  completed: boolean;
  exit: PtyExit | null;
}

export function handleExit(
  repository: PtyRepositoryService,
  eventBus: RuntimeEventBusService,
  activeAttachments: Map<number, ActiveAttachment>,
  intentionalKills: Map<number, IntentionalKillState>,
  ptySessionId: number,
  exit: PtyExit,
) {
  return Effect.gen(function* () {
    const killState = intentionalKills.get(ptySessionId);
    if (killState) {
      killState.exit = exit;
      activeAttachments.delete(ptySessionId);
      console.info(`[runtime] Ignoring backend exit for intentionally killed PTY ${ptySessionId}`);
      if (killState.completed) {
        intentionalKills.delete(ptySessionId);
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
  intentionalKills: Map<number, IntentionalKillState>,
  killState: IntentionalKillState,
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
                  statusReason: null,
                  exitCode: null,
                  signal: null,
                })
              : transitionSessionByIdAndPublish(repository, eventBus, {
                  ptySessionId,
                  status: 'killed',
                  statusReason: null,
                  exitCode: null,
                  signal: null,
                }),
          ),
        )
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              killState.completed = true;
              if (backend === 'tmux' || killState.exit) {
                intentionalKills.delete(ptySessionId);
              }
            }),
          ),
          Effect.catchAll((error) =>
            Effect.sync(() => {
              console.error(
                `[runtime] Failed to retry intentional PTY kill persistence for session ${ptySessionId}`,
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
