import { existsSync, mkdirSync } from 'node:fs';

import { Context, Effect, Either, Layer } from 'effect';

import type {
  LaunchSessionOutput,
  PtyWebSocketOutputMessage,
  SurfaceDeleteWarning,
} from '@isagi/contracts';

import { DataDirectory, DatabaseError } from '../persistence/index.js';
import { RuntimeEventBus, type RuntimeEventBusService } from '../runtime-events/index.js';
import type { PtySessionRow } from '../surfaces/index.js';
import { PtyBackend } from './backend.js';
import {
  appendLog,
  MissingLaunchWorktree,
  PtyRepository,
  type PtyRepositoryService,
} from './pty.repository.js';
import {
  detachActiveAttachment,
  requireActiveAttachment,
  type ActiveAttachment,
} from './service/attachments.js';
import { backendMetadataForLaunch, decodeBackendRef } from './service/backend-ref.js';
import { transitionSessionAndPublish, transitionSessionByIdAndPublish } from './service/events.js';
import { runPtyGc, startPtyGcLoop } from './service/gc.js';
import {
  handleExit,
  persistExit,
  retryPersistKilledUntilSuccess,
  type IntentionalKillState,
} from './service/lifecycle.js';
import {
  replaySessionLog,
  reportOrphanPtyLogs,
  replayBytesForSession,
  startOrphanPtyLogGcLoop,
} from './service/logs.js';
import {
  commandForLaunch,
  launchEnv,
  runtimeNamespace,
  spawnFailureMessage,
  titleForHarness,
} from './service/runtime-namespace.js';
import {
  PtyKillError,
  PtyResizeError,
  PtyServiceError,
  PtyWriteError,
  type BackendSessionRef,
  type LaunchPtySessionInput,
  type PtyBackend as PtyBackendShape,
  type PtySessionLaunchMetadata,
} from './types.js';

const defaultCols = 100;
const defaultRows = 30;
const statusPollIntervalMs = 10_000;

export type PtyLaunchError = DatabaseError | PtyServiceError;
export type PtyAttachError = DatabaseError | PtyServiceError;
export type PtyInputError = DatabaseError | PtyServiceError | PtyWriteError | PtyResizeError;
export type PtyKillSessionError = DatabaseError | PtyServiceError | PtyKillError;

export interface PtyAttachment {
  readonly session: PtySessionRow;
  readonly attachmentId: symbol | null;
  readonly replayBytes: number | null;
  readonly live: boolean;
  readonly unsubscribe: () => void;
}

export interface PtyService {
  readonly launch: (
    input: LaunchPtySessionInput,
  ) => Effect.Effect<LaunchSessionOutput, PtyLaunchError>;
  readonly attach: (input: {
    readonly ptySessionId: number;
    readonly send: (message: PtyWebSocketOutputMessage) => void;
  }) => Effect.Effect<PtyAttachment, PtyAttachError>;
  readonly replay: (input: {
    readonly session: PtySessionRow;
    readonly bytes: number | null;
    readonly send: (message: PtyWebSocketOutputMessage) => void;
  }) => Effect.Effect<void, PtyAttachError>;
  readonly write: (input: {
    readonly ptySessionId: number;
    readonly attachmentId: symbol | null;
    readonly data: string;
  }) => Effect.Effect<void, PtyInputError>;
  readonly resize: (input: {
    readonly ptySessionId: number;
    readonly attachmentId: symbol | null;
    readonly cols: number;
    readonly rows: number;
  }) => Effect.Effect<void, PtyInputError>;
  readonly kill: (input: {
    readonly ptySessionId: number;
  }) => Effect.Effect<void, PtyKillSessionError>;
  readonly cleanupSessionForDelete: (input: {
    readonly ptySessionId: number;
  }) => Effect.Effect<SurfaceDeleteWarning[], DatabaseError>;
}

export const PtyService = Context.GenericTag<PtyService>('isagi/PtyService');

export const PtyServiceLive = Layer.scoped(
  PtyService,
  Effect.gen(function* () {
    const repository = yield* PtyRepository;
    const backend = yield* PtyBackend;
    const directory = yield* DataDirectory;
    const eventBus = yield* RuntimeEventBus;
    const activeAttachments = new Map<number, ActiveAttachment>();
    const intentionalKills = new Map<number, IntentionalKillState>();
    const namespace = runtimeNamespace(directory.paths.root);

    mkdirSync(directory.paths.sessionsPath, { recursive: true });
    yield* reportOrphanPtyLogs(repository, directory.paths.sessionsPath);
    yield* reconcilePersistedSessions(repository, backend, eventBus, { startup: true });
    yield* runPtyGc(repository, backend, namespace);
    const pollTimer = startStatusPolling(repository, backend, eventBus);
    const gcTimer = startPtyGcLoop(repository, backend, namespace);
    const logGcTimer = startOrphanPtyLogGcLoop(repository, directory.paths.sessionsPath);

    const service = {
      launch: (input) =>
        Effect.gen(function* () {
          const command = commandForLaunch(input);
          const titleBase = input.purpose === 'agent' ? titleForHarness(input.harness) : 'Terminal';
          console.info(
            `[runtime] PTY launch starting purpose=${input.purpose} harness=${input.harness ?? 'none'} worktreeId=${input.worktreeId}`,
          );
          const metadata = yield* repository
            .createLaunchMetadata({
              worktreeId: input.worktreeId,
              kind: input.purpose,
              titleBase,
              purpose: input.purpose,
              harness: input.harness,
              command,
            })
            .pipe(
              Effect.catchAll((error): Effect.Effect<PtySessionLaunchMetadata, PtyLaunchError> => {
                if (
                  error instanceof DatabaseError &&
                  error.cause instanceof MissingLaunchWorktree
                ) {
                  return Effect.fail(
                    new PtyServiceError({
                      code: 'worktree_not_found',
                      message: error.cause.message,
                      worktreeId: input.worktreeId,
                      cause: error,
                    }),
                  );
                }
                return Effect.fail(error);
              }),
            );

          const startResult = yield* launchWithBackend({
            backend,
            metadata,
            repository,
            activeAttachments,
            runtimeNamespace: namespace,
            sessionsPath: directory.paths.sessionsPath,
            intentionalKills,
            eventBus,
          }).pipe(Effect.either);

          if (Either.isLeft(startResult)) {
            const message = spawnFailureMessage(metadata.command, metadata.cwd, startResult.left);
            console.warn(
              `[runtime] PTY launch failed ptySessionId=${metadata.ptySessionId} worktreeId=${metadata.worktreeId} command=${metadata.command}`,
              startResult.left,
            );
            const failedSession = yield* repository
              .findSession(metadata.ptySessionId)
              .pipe(Effect.orElseSucceed(() => null));
            if (failedSession?.logPath) {
              appendLog(failedSession.logPath, message);
            }
            yield* transitionSessionByIdAndPublish(repository, eventBus, {
              ptySessionId: metadata.ptySessionId,
              status: 'failed',
              statusReason: 'backend_launch_failed',
              exitCode: null,
              signal: null,
            });
          } else {
            console.info(
              `[runtime] PTY launch running ptySessionId=${metadata.ptySessionId} worktreeId=${metadata.worktreeId} backend=${startResult.right.backend}`,
            );
            yield* repository
              .updateBackendRef({
                ptySessionId: metadata.ptySessionId,
                backendRefJson: JSON.stringify(startResult.right),
              })
              .pipe(
                Effect.zipRight(
                  transitionSessionByIdAndPublish(repository, eventBus, {
                    ptySessionId: metadata.ptySessionId,
                    status: 'running',
                    statusReason: null,
                    exitCode: null,
                    signal: null,
                  }),
                ),
                Effect.catchAll((error) =>
                  backend
                    .kill(startResult.right)
                    .pipe(Effect.ignore, Effect.zipRight(Effect.fail(error))),
                ),
              );
          }

          return {
            worktreeId: metadata.worktreeId,
            surfaceId: metadata.surfaceId,
            paneId: metadata.paneId,
            ptySessionId: metadata.ptySessionId,
          } satisfies LaunchSessionOutput;
        }),
      attach: (input) =>
        Effect.gen(function* () {
          const session = yield* repository.findSession(input.ptySessionId);
          if (!session) {
            return yield* Effect.fail(
              new PtyServiceError({
                code: 'session_not_found',
                message: `PTY session ${input.ptySessionId} was not found.`,
                ptySessionId: input.ptySessionId,
              }),
            );
          }

          if (session.status !== 'running') {
            return {
              session,
              attachmentId: null,
              replayBytes: replayBytesForSession(session),
              live: false,
              unsubscribe: () => {},
            } satisfies PtyAttachment;
          }

          const ref = yield* decodeBackendRef(session);
          if (session.backend !== backend.name) {
            return yield* Effect.fail(
              new PtyServiceError({
                code: 'backend_unavailable',
                message: `PTY backend ${session.backend} is not active in this runtime process.`,
                ptySessionId: session.id,
              }),
            );
          }
          yield* detachActiveAttachment(activeAttachments, session.id);
          const attachResult = yield* backend
            .attach({
              ref,
              cols: defaultCols,
              rows: defaultRows,
              onOutput: (data) => input.send({ type: 'output', data }),
              onSessionExit: (exit) => input.send({ type: 'exit', ...exit }),
            })
            .pipe(Effect.either);

          if (Either.isLeft(attachResult)) {
            yield* handleAttachFailure(repository, backend, eventBus, session, ref);
            return yield* Effect.fail(
              new PtyServiceError({
                code: 'backend_attach_failed',
                message: `Could not attach to PTY session ${session.id}.`,
                ptySessionId: session.id,
                cause: attachResult.left,
              }),
            );
          }

          if (session.statusReason === 'backend_unavailable') {
            yield* transitionSessionAndPublish(repository, eventBus, session, {
              ptySessionId: session.id,
              status: 'running',
              statusReason: null,
              exitCode: session.exitCode,
              signal: session.signal,
            });
          }
          const attachmentId = Symbol(`pty-attachment-${session.id}`);
          activeAttachments.set(session.id, {
            ptySessionId: session.id,
            attachmentId,
            attachment: attachResult.right,
          });
          console.info(`[runtime] PTY websocket attach ptySessionId=${session.id} live=true`);

          return {
            session,
            attachmentId,
            replayBytes: replayBytesForSession(session),
            live: true,
            unsubscribe: () => {
              void Effect.runPromise(
                detachActiveAttachment(activeAttachments, session.id, attachmentId),
              );
            },
          } satisfies PtyAttachment;
        }),
      replay: (input) =>
        Effect.gen(function* () {
          if (input.session.logMode === 'backend_file') {
            yield* replaySessionLog({
              logPath: input.session.logPath,
              bytes: input.bytes,
              send: input.send,
            });
            return;
          }

          if (input.session.status !== 'running') {
            input.send({ type: 'replay_start', bytes: 0 });
            input.send({ type: 'replay_end' });
            return;
          }

          const ref = yield* decodeBackendRef(input.session);
          if (input.session.backend !== backend.name) {
            return yield* Effect.fail(
              new PtyServiceError({
                code: 'backend_unavailable',
                message: `PTY backend ${input.session.backend} is not active in this runtime process.`,
                ptySessionId: input.session.id,
              }),
            );
          }
          yield* backend.replay({
            ref,
            logPath: input.session.logPath,
            bytes: input.bytes,
            send: input.send,
          });
        }),
      write: (input) =>
        Effect.gen(function* () {
          const active = yield* requireActiveAttachment(
            activeAttachments,
            input.ptySessionId,
            input.attachmentId,
          );
          yield* active.attachment.write(input.data);
        }),
      resize: (input) =>
        Effect.gen(function* () {
          const active = yield* requireActiveAttachment(
            activeAttachments,
            input.ptySessionId,
            input.attachmentId,
          );
          yield* active.attachment.resize({ cols: input.cols, rows: input.rows });
        }),
      kill: (input) =>
        Effect.gen(function* () {
          const session = yield* repository.findSession(input.ptySessionId);
          if (!session) {
            return yield* Effect.fail(
              new PtyServiceError({
                code: 'session_not_found',
                message: `PTY session ${input.ptySessionId} was not found.`,
                ptySessionId: input.ptySessionId,
              }),
            );
          }
          const ref = yield* decodeBackendRef(session);
          if (session.backend !== backend.name) {
            return yield* Effect.fail(
              new PtyServiceError({
                code: 'backend_unavailable',
                message: `PTY backend ${session.backend} is not active in this runtime process.`,
                ptySessionId: session.id,
              }),
            );
          }
          const killState: IntentionalKillState = {
            completed: false,
            exit: null,
          };
          intentionalKills.set(session.id, killState);
          yield* detachActiveAttachment(activeAttachments, session.id);
          const killResult = yield* backend.kill(ref).pipe(Effect.either);
          if (Either.isLeft(killResult)) {
            intentionalKills.delete(session.id);
            if (killState.exit) {
              yield* persistExit(
                repository,
                eventBus,
                activeAttachments,
                session.id,
                killState.exit,
              );
            }
            return yield* Effect.fail(killResult.left);
          }
          const transitionResult = yield* transitionSessionAndPublish(
            repository,
            eventBus,
            session,
            {
              ptySessionId: session.id,
              status: 'killed',
              statusReason: null,
              exitCode: null,
              signal: null,
            },
          ).pipe(Effect.either);
          if (Either.isLeft(transitionResult)) {
            retryPersistKilledUntilSuccess(
              repository,
              eventBus,
              intentionalKills,
              killState,
              session.backend,
              session.id,
            );
            return yield* Effect.fail(transitionResult.left);
          }
          killState.completed = true;
          if (session.backend === 'tmux' || killState.exit) {
            intentionalKills.delete(session.id);
          }
          console.info(`[runtime] PTY session killed ptySessionId=${session.id}`);
        }),
      cleanupSessionForDelete: (input) =>
        Effect.gen(function* () {
          const session = yield* repository.findSession(input.ptySessionId);
          if (!session || (session.status !== 'starting' && session.status !== 'running')) {
            return [];
          }

          if (session.backend !== backend.name) {
            return [deleteCleanupWarning('pty_backend_unavailable', session.paneId, session.id)];
          }

          const ref = yield* decodeBackendRef(session).pipe(
            Effect.catchAll(() => Effect.succeed<BackendSessionRef | null>(null)),
          );
          if (!ref) {
            return [deleteCleanupWarning('pty_kill_failed', session.paneId, session.id)];
          }

          yield* detachActiveAttachment(activeAttachments, session.id);
          const inspection = yield* backend
            .inspect(ref)
            .pipe(Effect.catchAll(() => Effect.succeed({ status: 'unavailable' as const })));
          if (inspection.status === 'missing') {
            return [];
          }
          if (inspection.status === 'unavailable') {
            // Immediate cleanup could not happen in this runtime process. The
            // durable row is still deleted by SurfaceService; backend GC can
            // retry orphan cleanup later when the relevant backend is available.
            return [deleteCleanupWarning('pty_backend_unavailable', session.paneId, session.id)];
          }

          const killResult = yield* backend.kill(ref).pipe(Effect.either);
          if (Either.isLeft(killResult)) {
            console.warn(
              `[runtime] PTY delete cleanup could not kill backend session ptySessionId=${session.id}`,
              killResult.left,
            );
            return [deleteCleanupWarning('pty_kill_failed', session.paneId, session.id)];
          }

          // Delete cleanup intentionally does not persist a durable `killed` state:
          // user intent is to remove the pane/surface now, and the DB rows are deleted
          // by SurfaceService immediately after this best-effort backend cleanup.
          console.info(`[runtime] PTY session prepared for delete ptySessionId=${session.id}`);
          return [];
        }),
    } satisfies PtyService;

    return yield* Effect.acquireRelease(Effect.succeed(service), () =>
      Effect.gen(function* () {
        clearInterval(pollTimer);
        clearInterval(gcTimer);
        clearInterval(logGcTimer);
        const sessions = yield* repository
          .listSessions({ statuses: ['starting', 'running'] })
          .pipe(Effect.orElseSucceed(() => []));
        for (const active of activeAttachments.values()) {
          yield* active.attachment.detach;
        }
        activeAttachments.clear();
        for (const session of sessions) {
          if (session.backend !== 'node_pty') {
            continue;
          }
          const ref = yield* decodeBackendRef(session).pipe(Effect.orElseSucceed(() => null));
          if (ref) {
            if (session.backend !== backend.name) {
              continue;
            }
            yield* backend.kill(ref).pipe(Effect.ignore);
          }
          yield* transitionSessionAndPublish(repository, eventBus, session, {
            ptySessionId: session.id,
            status: 'failed',
            statusReason: null,
            exitCode: null,
            signal: null,
          }).pipe(Effect.ignore);
        }
      }),
    );
  }),
);

function startStatusPolling(
  repository: PtyRepositoryService,
  backend: PtyBackendShape,
  eventBus: RuntimeEventBusService,
) {
  const timer = setInterval(() => {
    void Effect.runPromise(
      reconcilePersistedSessions(repository, backend, eventBus, { startup: false }).pipe(
        Effect.catchAll((error) =>
          Effect.sync(() => {
            console.warn('[runtime] PTY status polling failed', error);
          }),
        ),
      ),
    );
  }, statusPollIntervalMs);
  timer.unref();
  return timer;
}

function deleteCleanupWarning(
  code: SurfaceDeleteWarning['code'],
  paneId: number,
  ptySessionId: number,
): SurfaceDeleteWarning {
  return { code, paneId, ptySessionId };
}

function reconcilePersistedSessions(
  repository: PtyRepositoryService,
  backend: PtyBackendShape,
  eventBus: RuntimeEventBusService,
  options: { readonly startup: boolean },
) {
  return Effect.gen(function* () {
    const sessions = yield* repository.listSessions({ statuses: ['starting', 'running'] });
    for (const session of sessions) {
      if (session.backend === 'node_pty' && options.startup) {
        yield* transitionIfChanged(repository, eventBus, session, {
          status: 'failed',
          statusReason: 'runtime_ephemeral_lost',
        });
        continue;
      }

      const ref = yield* decodeBackendRef(session).pipe(Effect.orElseSucceed(() => null));
      if (!ref) {
        yield* transitionIfChanged(repository, eventBus, session, {
          status: 'failed',
          statusReason: 'backend_session_missing',
        });
        continue;
      }
      if (session.backend !== backend.name) {
        yield* transitionIfChanged(repository, eventBus, session, {
          status: 'running',
          statusReason: 'backend_unavailable',
        });
        continue;
      }
      const inspection = yield* backend
        .inspect(ref)
        .pipe(
          Effect.catchAll((cause) => Effect.succeed({ status: 'unavailable' as const, cause })),
        );
      switch (inspection.status) {
        case 'alive':
          yield* transitionIfChanged(
            repository,
            eventBus,
            session,
            { status: 'running', statusReason: null },
            options.startup ? new Date().toISOString() : undefined,
          );
          break;
        case 'unavailable':
          yield* transitionIfChanged(repository, eventBus, session, {
            status: 'running',
            statusReason: 'backend_unavailable',
          });
          break;
        case 'missing':
          // Phase 2 limitation: tmux cannot currently distinguish normal shell exit from
          // externally missing backend session. Treat all missing tmux sessions as failed
          // until the backend records exit attribution explicitly.
          yield* transitionIfChanged(repository, eventBus, session, {
            status: 'failed',
            statusReason:
              session.backend === 'node_pty' ? 'runtime_ephemeral_lost' : 'backend_session_missing',
          });
          break;
      }
    }
  });
}

function launchWithBackend(input: {
  readonly backend: PtyBackendShape;
  readonly metadata: PtySessionLaunchMetadata;
  readonly repository: PtyRepositoryService;
  readonly activeAttachments: Map<number, ActiveAttachment>;
  readonly runtimeNamespace: string;
  readonly sessionsPath: string;
  readonly intentionalKills: Map<number, IntentionalKillState>;
  readonly eventBus: RuntimeEventBusService;
}) {
  return Effect.gen(function* () {
    const backendMetadata = backendMetadataForLaunch(
      input.backend,
      input.metadata,
      input.runtimeNamespace,
      input.sessionsPath,
    );
    if (backendMetadata.logPath && !existsSync(backendMetadata.logPath)) {
      appendLog(backendMetadata.logPath, '');
    }
    yield* input.repository.updateBackendMetadata({
      ptySessionId: input.metadata.ptySessionId,
      backend: input.backend.name,
      backendRefJson: JSON.stringify(backendMetadata.ref),
      logMode: backendMetadata.logMode,
      logPath: backendMetadata.logPath,
    });
    const startResult = yield* input.backend.launch({
      ptySessionId: input.metadata.ptySessionId,
      backendSessionName: backendMetadata.backendSessionName,
      command: input.metadata.command,
      cwd: input.metadata.cwd,
      env: launchEnv(),
      cols: defaultCols,
      rows: defaultRows,
      logPath: backendMetadata.logPath,
      onExit: (exit) =>
        void Effect.runPromise(
          handleExit(
            input.repository,
            input.eventBus,
            input.activeAttachments,
            input.intentionalKills,
            input.metadata.ptySessionId,
            exit,
          ),
        ),
    });
    return startResult;
  });
}

function handleAttachFailure(
  repository: PtyRepositoryService,
  backend: PtyBackendShape,
  eventBus: RuntimeEventBusService,
  session: PtySessionRow,
  ref: BackendSessionRef,
) {
  return Effect.gen(function* () {
    if (session.backend === 'node_pty') {
      yield* transitionIfChanged(repository, eventBus, session, {
        status: 'failed',
        statusReason: 'runtime_ephemeral_lost',
      });
      return;
    }
    const inspection = yield* backend
      .inspect(ref)
      .pipe(Effect.catchAll((cause) => Effect.succeed({ status: 'unavailable' as const, cause })));
    if (inspection.status === 'missing') {
      yield* transitionIfChanged(repository, eventBus, session, {
        status: 'failed',
        statusReason: 'backend_session_missing',
      });
      return;
    }
    if (inspection.status === 'unavailable') {
      yield* transitionIfChanged(repository, eventBus, session, {
        status: 'running',
        statusReason: 'backend_unavailable',
      });
    }
  });
}

function transitionIfChanged(
  repository: PtyRepositoryService,
  eventBus: RuntimeEventBusService,
  session: PtySessionRow,
  next: {
    readonly status: PtySessionRow['status'];
    readonly statusReason: PtySessionRow['statusReason'];
  },
  lastSeenAt?: string,
) {
  if (
    session.status === next.status &&
    session.statusReason === next.statusReason &&
    lastSeenAt === undefined
  ) {
    return Effect.void;
  }
  return transitionSessionAndPublish(repository, eventBus, session, {
    ptySessionId: session.id,
    status: next.status,
    statusReason: next.statusReason,
    exitCode: next.status === 'running' ? null : session.exitCode,
    signal: next.status === 'running' ? null : session.signal,
    ...(lastSeenAt !== undefined ? { lastSeenAt } : {}),
  });
}
