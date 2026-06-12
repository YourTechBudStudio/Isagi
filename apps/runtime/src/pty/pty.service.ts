import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import process from 'node:process';

import { Context, Effect, Either, Layer, Schema } from 'effect';

import type { LaunchSessionOutput, PtyWebSocketOutputMessage } from '@isagi/contracts';

import { DataDirectory, DatabaseError } from '../persistence/index.js';
import type { PtySessionRow } from '../surfaces/index.js';
import { PtyBackendRegistry } from './pty-backend-registry.js';
import {
  appendLog,
  MissingLaunchWorktree,
  PtyRepository,
  type PtyRepositoryService,
} from './pty.repository.js';
import {
  PtyResizeError,
  PtyServiceError,
  PtyWriteError,
  type BackendAttachment,
  type BackendSessionRef,
  type LaunchPtySessionInput,
  type PtyBackend,
  type PtyBackendRegistry as PtyBackendRegistryService,
  type PtyExit,
  type PtySessionLaunchMetadata,
} from './types.js';

const defaultCols = 100;
const defaultRows = 30;
const orphanLogSampleSize = 5;
const statusPollIntervalMs = 10_000;

const nodePtyBackendRefSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  backend: Schema.Literal('node_pty'),
  ptySessionId: Schema.Number.pipe(Schema.int(), Schema.positive()),
  pid: Schema.NullOr(Schema.Number.pipe(Schema.int())),
});

const tmuxBackendRefSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  backend: Schema.Literal('tmux'),
  sessionName: Schema.String.pipe(Schema.minLength(1)),
});

export type PtyLaunchError = DatabaseError | PtyServiceError;
export type PtyAttachError = DatabaseError | PtyServiceError;
export type PtyInputError = DatabaseError | PtyServiceError | PtyWriteError | PtyResizeError;

interface ActiveAttachment {
  readonly ptySessionId: number;
  readonly attachmentId: symbol;
  readonly attachment: BackendAttachment;
}

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
}

export const PtyService = Context.GenericTag<PtyService>('isagi/PtyService');

export const PtyServiceLive = Layer.scoped(
  PtyService,
  Effect.gen(function* () {
    const repository = yield* PtyRepository;
    const registry = yield* PtyBackendRegistry;
    const directory = yield* DataDirectory;
    const activeAttachments = new Map<number, ActiveAttachment>();
    const dataDirHash = dataDirectoryHash(directory.paths.root);

    mkdirSync(directory.paths.sessionsPath, { recursive: true });
    yield* reportOrphanPtyLogs(repository, directory.paths.sessionsPath);
    yield* reconcilePersistedSessions(repository, registry, { startup: true });
    const pollTimer = startStatusPolling(repository, registry);

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

          const selectedBackend = yield* registry.selectForLaunch();
          const launchResult = yield* launchWithBackend({
            backend: selectedBackend,
            metadata,
            repository,
            activeAttachments,
            dataDirHash,
            sessionsPath: directory.paths.sessionsPath,
          }).pipe(Effect.either);
          const startResult =
            Either.isLeft(launchResult) && selectedBackend.name === 'tmux'
              ? yield* Effect.gen(function* () {
                  yield* bestEffortKillPersistedSession(
                    repository,
                    registry,
                    metadata.ptySessionId,
                  );
                  const fallbackBackend = yield* registry.get('node_pty').pipe(
                    Effect.mapError(
                      (error) =>
                        new PtyServiceError({
                          code: 'backend_unavailable',
                          message: `PTY backend ${error.backend} is not supported.`,
                          ptySessionId: metadata.ptySessionId,
                          cause: error,
                        }),
                    ),
                  );
                  return yield* launchWithBackend({
                    backend: fallbackBackend,
                    metadata,
                    repository,
                    activeAttachments,
                    dataDirHash,
                    sessionsPath: directory.paths.sessionsPath,
                  }).pipe(Effect.either);
                })
              : launchResult;

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
            yield* repository.transitionSession({
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
                  repository.transitionSession({
                    ptySessionId: metadata.ptySessionId,
                    status: 'running',
                    statusReason: null,
                    exitCode: null,
                    signal: null,
                  }),
                ),
                Effect.catchAll((error) =>
                  registry
                    .get(startResult.right.backend)
                    .pipe(Effect.flatMap((backend) => backend.kill(startResult.right)))
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
          const backend = yield* registry.get(session.backend).pipe(
            Effect.mapError(
              (error) =>
                new PtyServiceError({
                  code: 'backend_unavailable',
                  message: `PTY backend ${error.backend} is not supported.`,
                  ptySessionId: session.id,
                  cause: error,
                }),
            ),
          );
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
            yield* handleAttachFailure(repository, backend, session, ref);
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
            yield* repository.transitionSession({
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
          const ref = yield* decodeBackendRef(input.session);
          const backend = yield* registry.get(input.session.backend).pipe(
            Effect.mapError(
              (error) =>
                new PtyServiceError({
                  code: 'backend_unavailable',
                  message: `PTY backend ${error.backend} is not supported.`,
                  ptySessionId: input.session.id,
                  cause: error,
                }),
            ),
          );
          yield* backend.replay({
            ref,
            logPath: input.session.logPath,
            bytes: input.bytes,
            send: input.send,
          });
        }),
      write: (input) =>
        Effect.gen(function* () {
          const active = activeAttachments.get(input.ptySessionId);
          if (!active || active.attachmentId !== input.attachmentId) {
            return yield* Effect.fail(
              new PtyServiceError({
                code: 'session_not_running',
                message: `PTY session ${input.ptySessionId} is not running.`,
                ptySessionId: input.ptySessionId,
              }),
            );
          }
          yield* active.attachment.write(input.data);
        }),
      resize: (input) =>
        Effect.gen(function* () {
          const active = activeAttachments.get(input.ptySessionId);
          if (!active || active.attachmentId !== input.attachmentId) {
            return yield* Effect.fail(
              new PtyServiceError({
                code: 'session_not_running',
                message: `PTY session ${input.ptySessionId} is not running.`,
                ptySessionId: input.ptySessionId,
              }),
            );
          }
          yield* active.attachment.resize({ cols: input.cols, rows: input.rows });
        }),
    } satisfies PtyService;

    return yield* Effect.acquireRelease(Effect.succeed(service), () =>
      Effect.gen(function* () {
        clearInterval(pollTimer);
        const sessions = yield* repository.listLivePersistedSessions.pipe(
          Effect.orElseSucceed(() => []),
        );
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
            const backend = yield* registry
              .get(session.backend)
              .pipe(Effect.orElseSucceed(() => null));
            if (!backend) {
              continue;
            }
            yield* backend.kill(ref).pipe(Effect.ignore);
          }
          yield* repository
            .transitionSession({
              ptySessionId: session.id,
              status: 'failed',
              statusReason: null,
              exitCode: null,
              signal: null,
            })
            .pipe(Effect.ignore);
        }
      }),
    );
  }),
);

function startStatusPolling(repository: PtyRepositoryService, registry: PtyBackendRegistryService) {
  const timer = setInterval(() => {
    void Effect.runPromise(
      reconcilePersistedSessions(repository, registry, { startup: false }).pipe(
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

function reconcilePersistedSessions(
  repository: PtyRepositoryService,
  registry: PtyBackendRegistryService,
  options: { readonly startup: boolean },
) {
  return Effect.gen(function* () {
    const sessions = yield* repository.listLivePersistedSessions;
    for (const session of sessions) {
      if (session.backend === 'node_pty' && options.startup) {
        yield* transitionIfChanged(repository, session, {
          status: 'failed',
          statusReason: 'runtime_ephemeral_lost',
        });
        continue;
      }

      const ref = yield* decodeBackendRef(session).pipe(Effect.orElseSucceed(() => null));
      if (!ref) {
        yield* transitionIfChanged(repository, session, {
          status: 'failed',
          statusReason: 'backend_session_missing',
        });
        continue;
      }
      const backend = yield* registry.get(session.backend).pipe(Effect.orElseSucceed(() => null));
      if (!backend) {
        yield* transitionIfChanged(repository, session, {
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
            session,
            { status: 'running', statusReason: null },
            options.startup ? new Date().toISOString() : undefined,
          );
          break;
        case 'unavailable':
          yield* transitionIfChanged(repository, session, {
            status: 'running',
            statusReason: 'backend_unavailable',
          });
          break;
        case 'missing':
          // Phase 2 limitation: tmux cannot currently distinguish normal shell exit from
          // externally missing backend session. Treat all missing tmux sessions as failed
          // until the backend records exit attribution explicitly.
          yield* transitionIfChanged(repository, session, {
            status: 'failed',
            statusReason:
              session.backend === 'node_pty' ? 'runtime_ephemeral_lost' : 'backend_session_missing',
          });
          break;
      }
    }
  });
}

function reportOrphanPtyLogs(repository: PtyRepositoryService, sessionsPath: string) {
  return detectOrphanPtyLogs(repository, sessionsPath).pipe(
    Effect.tap((orphans) =>
      Effect.sync(() => {
        if (orphans.length === 0) {
          return;
        }
        const sample = orphans.slice(0, orphanLogSampleSize).join(', ');
        const suffix = orphans.length > orphanLogSampleSize ? ', ...' : '';
        console.warn(
          `[runtime] Found ${orphans.length} orphan PTY log file(s) under sessions/: ${sample}${suffix}`,
        );
      }),
    ),
    Effect.catchAll((error) =>
      Effect.sync(() => {
        console.warn('[runtime] Could not inspect PTY session logs for orphans', error);
      }),
    ),
  );
}

export function detectOrphanPtyLogs(repository: PtyRepositoryService, sessionsPath: string) {
  return Effect.gen(function* () {
    const referencedLogPaths = new Set((yield* repository.listSessionLogPaths).map(normalizePath));
    const entries = yield* Effect.try({
      try: () => readdirSync(sessionsPath, { withFileTypes: true }),
      catch: (cause) =>
        new PtyServiceError({
          code: 'log_read_failed',
          message: 'Could not inspect PTY session logs.',
          cause,
        }),
    });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ptylog'))
      .map((entry) => join(sessionsPath, entry.name))
      .filter((path) => !referencedLogPaths.has(normalizePath(path)))
      .map((path) => relativeSessionLogPath(sessionsPath, path))
      .sort();
  });
}

function launchWithBackend(input: {
  readonly backend: PtyBackend;
  readonly metadata: PtySessionLaunchMetadata;
  readonly repository: PtyRepositoryService;
  readonly activeAttachments: Map<number, ActiveAttachment>;
  readonly dataDirHash: string;
  readonly sessionsPath: string;
}) {
  return Effect.gen(function* () {
    const backendMetadata = backendMetadataForLaunch(
      input.backend,
      input.metadata,
      input.dataDirHash,
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
          handleExit(input.repository, input.activeAttachments, input.metadata.ptySessionId, exit),
        ),
    });
    return startResult;
  });
}

function backendMetadataForLaunch(
  backend: PtyBackend,
  metadata: PtySessionLaunchMetadata,
  dataDirHash: string,
  sessionsPath: string,
) {
  if (backend.name === 'tmux') {
    const sessionName = `isagi_${dataDirHash}_${metadata.ptySessionId}`;
    return {
      backendSessionName: sessionName,
      logMode: 'none' as const,
      logPath: null,
      ref: {
        schemaVersion: 1,
        backend: 'tmux',
        sessionName,
      } as const,
    };
  }
  const logPath = join(sessionsPath, `${metadata.ptySessionId}.ptylog`);
  return {
    backendSessionName: null,
    logMode: 'backend_file' as const,
    logPath: metadata.logPath ?? logPath,
    ref: {
      schemaVersion: 1,
      backend: 'node_pty',
      ptySessionId: metadata.ptySessionId,
      pid: null,
    } as const,
  };
}

function handleAttachFailure(
  repository: PtyRepositoryService,
  backend: PtyBackend,
  session: PtySessionRow,
  ref: BackendSessionRef,
) {
  return Effect.gen(function* () {
    if (session.backend === 'node_pty') {
      yield* transitionIfChanged(repository, session, {
        status: 'failed',
        statusReason: 'runtime_ephemeral_lost',
      });
      return;
    }
    const inspection = yield* backend
      .inspect(ref)
      .pipe(Effect.catchAll((cause) => Effect.succeed({ status: 'unavailable' as const, cause })));
    if (inspection.status === 'missing') {
      yield* transitionIfChanged(repository, session, {
        status: 'failed',
        statusReason: 'backend_session_missing',
      });
      return;
    }
    if (inspection.status === 'unavailable') {
      yield* transitionIfChanged(repository, session, {
        status: 'running',
        statusReason: 'backend_unavailable',
      });
    }
  });
}

function bestEffortKillPersistedSession(
  repository: PtyRepositoryService,
  registry: PtyBackendRegistryService,
  ptySessionId: number,
) {
  return Effect.gen(function* () {
    const session = yield* repository
      .findSession(ptySessionId)
      .pipe(Effect.orElseSucceed(() => null));
    if (!session) {
      return;
    }
    const ref = yield* decodeBackendRef(session).pipe(Effect.orElseSucceed(() => null));
    if (!ref) {
      return;
    }
    const backend = yield* registry.get(session.backend).pipe(Effect.orElseSucceed(() => null));
    if (!backend) {
      return;
    }
    yield* backend.kill(ref).pipe(Effect.ignore);
  });
}

function transitionIfChanged(
  repository: PtyRepositoryService,
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
  return repository.transitionSession({
    ptySessionId: session.id,
    status: next.status,
    statusReason: next.statusReason,
    exitCode: next.status === 'running' ? null : session.exitCode,
    signal: next.status === 'running' ? null : session.signal,
    ...(lastSeenAt !== undefined ? { lastSeenAt } : {}),
  });
}

function detachActiveAttachment(
  activeAttachments: Map<number, ActiveAttachment>,
  ptySessionId: number,
  attachmentId?: symbol,
) {
  return Effect.gen(function* () {
    const active = activeAttachments.get(ptySessionId);
    if (!active) {
      return;
    }
    if (attachmentId && active.attachmentId !== attachmentId) {
      return;
    }
    activeAttachments.delete(ptySessionId);
    yield* active.attachment.detach;
    console.info(`[runtime] PTY websocket detach ptySessionId=${ptySessionId}`);
  });
}

function replayBytesForSession(session: PtySessionRow) {
  if (session.logMode !== 'backend_file' || !session.logPath) {
    return null;
  }
  try {
    return statSync(session.logPath).size;
  } catch {
    return 0;
  }
}

function decodeBackendRef(
  session: PtySessionRow,
): Effect.Effect<BackendSessionRef, PtyServiceError> {
  return Effect.try({
    try: () => {
      const raw = JSON.parse(session.backendRefJson);
      if (session.backend === 'tmux') {
        return Schema.decodeUnknownSync(tmuxBackendRefSchema)(raw);
      }
      const ref = Schema.decodeUnknownSync(nodePtyBackendRefSchema)(raw);
      if (ref.ptySessionId === session.id) {
        return ref;
      }
      throw new Error(
        `Backend ref ptySessionId ${ref.ptySessionId} does not match row id ${session.id}.`,
      );
    },
    catch: (cause) =>
      new PtyServiceError({
        code: 'backend_session_missing',
        message: `PTY session ${session.id} has an invalid or unsupported backend ref.`,
        ptySessionId: session.id,
        cause,
      }),
  });
}

function normalizePath(path: string) {
  return relative(process.cwd(), path);
}

function relativeSessionLogPath(sessionsPath: string, path: string) {
  const relativePath = relative(sessionsPath, path);
  return relativePath.startsWith('..') ? basename(path) : `sessions/${relativePath}`;
}

function handleExit(
  repository: PtyRepositoryService,
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
    yield* repository.transitionSession({
      ptySessionId,
      status,
      statusReason: null,
      exitCode: exit.exitCode,
      signal: exit.signal,
    });
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        console.error(`[runtime] Failed to persist PTY exit for session ${ptySessionId}`, error);
        scheduleExitPersistenceRetry(repository, activeAttachments, ptySessionId, exit);
      }),
    ),
  );
}

function scheduleExitPersistenceRetry(
  repository: PtyRepositoryService,
  activeAttachments: Map<number, ActiveAttachment>,
  ptySessionId: number,
  exit: PtyExit,
) {
  const retry = () => {
    void Effect.runPromise(
      Effect.gen(function* () {
        const status = exit.exitCode === 0 && exit.signal === null ? 'exited' : 'failed';
        activeAttachments.delete(ptySessionId);
        yield* repository.transitionSession({
          ptySessionId,
          status,
          statusReason: null,
          exitCode: exit.exitCode,
          signal: exit.signal,
        });
      }).pipe(
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

function commandForLaunch(input: LaunchPtySessionInput) {
  if (input.purpose === 'terminal') {
    return process.env.SHELL || 'bash';
  }
  return input.harness ?? 'pi';
}

function titleForHarness(harness: LaunchPtySessionInput['harness']) {
  switch (harness) {
    case 'opencode':
      return 'OpenCode';
    case 'claude':
      return 'Claude';
    case 'codex':
      return 'Codex';
    case 'pi':
    default:
      return 'Pi';
  }
}

function launchEnv() {
  return {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  } satisfies NodeJS.ProcessEnv;
}

function dataDirectoryHash(root: string) {
  return createHash('sha256').update(resolve(root)).digest('hex').slice(0, 8);
}

function spawnFailureMessage(command: string, cwd: string, error: unknown) {
  const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : error;
  const reason = cause instanceof Error && cause.message ? cause.message : String(cause);
  return `\r\nFailed to start ${command} in ${cwd}: ${reason}\r\n`;
}
