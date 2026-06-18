import { Effect } from 'effect';

import type { InternalRuntimeEventBusService } from '../../runtime-events/index.js';
import type { PtyProcessRecord } from '../../surfaces/index.js';
import type { PtyRepositoryService } from '../pty.repository.js';
import type { PtyProcessStatusReason } from '../types.js';
import type { PtyExit } from '../types.js';
import type { ActiveAttachment } from './attachments.js';
import { transitionProcessAndPublish, transitionProcessByIdAndPublish } from './events.js';

export interface PtyTerminationState {
  completed: boolean;
  exit: PtyExit | null;
  reason: Extract<PtyProcessStatusReason, 'user_requested' | 'runtime_shutdown'>;
  outcome: 'persist_killed' | 'delete_session';
}

export function handleExit(
  repository: PtyRepositoryService,
  eventBus: InternalRuntimeEventBusService,
  activeAttachments: Map<number, ActiveAttachment>,
  terminations: Map<number, PtyTerminationState>,
  ptyProcessId: number,
  exit: PtyExit,
) {
  return Effect.gen(function* () {
    const termination = terminations.get(ptyProcessId);
    if (termination) {
      termination.exit = exit;
      activeAttachments.delete(ptyProcessId);
      console.info(
        `[runtime] Ignoring backend exit for terminating PTY ${ptyProcessId} reason=${termination.reason} outcome=${termination.outcome}`,
      );
      if (termination.completed) {
        terminations.delete(ptyProcessId);
      }
      return;
    }
    yield* persistExit(repository, eventBus, activeAttachments, ptyProcessId, exit);
  });
}

export function persistExit(
  repository: PtyRepositoryService,
  eventBus: InternalRuntimeEventBusService,
  activeAttachments: Map<number, ActiveAttachment>,
  ptyProcessId: number,
  exit: PtyExit,
) {
  return persistExitOnce(repository, eventBus, activeAttachments, ptyProcessId, exit).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        console.error(`[runtime] Failed to persist PTY exit for session ${ptyProcessId}`, error);
        retryPersistExitUntilSuccess(repository, eventBus, activeAttachments, ptyProcessId, exit);
      }),
    ),
  );
}

export function retryPersistKilledUntilSuccess(
  repository: PtyRepositoryService,
  eventBus: InternalRuntimeEventBusService,
  terminations: Map<number, PtyTerminationState>,
  termination: PtyTerminationState,
  backend: PtyProcessRecord['backend'],
  ptyProcessId: number,
) {
  const retry = () => {
    void Effect.runPromise(
      repository
        .findProcess(ptyProcessId)
        .pipe(
          Effect.flatMap((session) =>
            session
              ? transitionProcessAndPublish(repository, eventBus, session, {
                  ptyProcessId,
                  status: 'killed',
                  statusReason: termination.reason,
                  exitCode: null,
                  signal: null,
                })
              : transitionProcessByIdAndPublish(repository, eventBus, {
                  ptyProcessId,
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
                terminations.delete(ptyProcessId);
              }
            }),
          ),
          Effect.catchAll((error) =>
            Effect.sync(() => {
              console.error(
                `[runtime] Failed to retry PTY termination persistence for session ${ptyProcessId}`,
                error,
              );
              scheduleRetry(retry);
            }),
          ),
        ),
    );
  };

  scheduleRetry(retry);
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
    console.info(
      `[runtime] PTY exited ptyProcessId=${ptyProcessId} status=${status} exitCode=${exit.exitCode ?? 'null'} signal=${exit.signal ?? 'null'}`,
    );
    activeAttachments.delete(ptyProcessId);
    yield* transitionProcessByIdAndPublish(repository, eventBus, {
      ptyProcessId,
      status,
      statusReason: null,
      exitCode: exit.exitCode,
      signal: exit.signal,
    });
  });
}

function retryPersistExitUntilSuccess(
  repository: PtyRepositoryService,
  eventBus: InternalRuntimeEventBusService,
  activeAttachments: Map<number, ActiveAttachment>,
  ptyProcessId: number,
  exit: PtyExit,
) {
  const retry = () => {
    void Effect.runPromise(
      persistExitOnce(repository, eventBus, activeAttachments, ptyProcessId, exit).pipe(
        Effect.catchAll((error) =>
          Effect.sync(() => {
            console.error(
              `[runtime] Failed to retry PTY exit persistence for session ${ptyProcessId}`,
              error,
            );
            scheduleRetry(retry);
          }),
        ),
      ),
    );
  };

  scheduleRetry(retry);
}

function scheduleRetry(retry: () => void) {
  const timer = setTimeout(retry, 1_000);
  timer.unref();
}
