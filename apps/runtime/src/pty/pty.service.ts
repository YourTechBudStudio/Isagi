import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, join, relative } from 'node:path';
import process from 'node:process';

import { Context, Data, Effect, Either, Layer } from 'effect';

import type {
  LaunchSessionOutput,
  PtySessionStatus,
  PtyWebSocketOutputMessage,
} from '@isagi/contracts';

import { DataDirectory, DatabaseError } from '../persistence/index.js';
import type { PtySessionRow } from '../surfaces/index.js';
import { PtyAdapter } from './node-pty.adapter.js';
import {
  appendLog,
  MissingLaunchWorktree,
  PtyRepository,
  type PtyRepositoryService,
} from './pty.repository.js';
import {
  PtyResizeError,
  PtyStartError,
  PtyWriteError,
  type LaunchPtySessionInput,
  type PtyExit,
  type PtyHandle,
  type PtySessionLaunchMetadata,
} from './types.js';

const defaultCols = 100;
const defaultRows = 30;
const replayChunkBytes = 64 * 1024;
const restartNote = '\r\nRuntime restarted; this session is no longer live.\r\n';
const shutdownNote = '\r\nRuntime shut down before this session reported an exit status.\r\n';
const orphanLogSampleSize = 5;

export class PtyServiceError extends Data.TaggedError('PtyServiceError')<{
  readonly code:
    | 'worktree_not_found'
    | 'session_not_found'
    | 'session_not_running'
    | 'log_read_failed';
  readonly message: string;
  readonly worktreeId?: number | undefined;
  readonly ptySessionId?: number | undefined;
  readonly cause?: unknown;
}> {}

export type PtyLaunchError = DatabaseError | PtyServiceError;
export type PtyAttachError = DatabaseError | PtyServiceError;
export type PtyInputError = DatabaseError | PtyServiceError | PtyWriteError | PtyResizeError;

interface LiveSession {
  readonly handle: PtyHandle;
  status: PtySessionStatus;
  logBytes: number;
  pendingLogBytes: boolean;
  flushTimer: NodeJS.Timeout | null;
  readonly subscribers: Set<(message: PtyWebSocketOutputMessage) => void>;
}

export interface PtyAttachment {
  readonly session: PtySessionRow;
  readonly replayOffset: number;
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
    readonly bytes: number;
    readonly send: (message: PtyWebSocketOutputMessage) => void;
  }) => Effect.Effect<void, PtyAttachError>;
  readonly write: (input: {
    readonly ptySessionId: number;
    readonly data: string;
  }) => Effect.Effect<void, PtyInputError>;
  readonly resize: (input: {
    readonly ptySessionId: number;
    readonly cols: number;
    readonly rows: number;
  }) => Effect.Effect<void, PtyInputError>;
}

export const PtyService = Context.GenericTag<PtyService>('isagi/PtyService');

export const PtyServiceLive = Layer.scoped(
  PtyService,
  Effect.gen(function* () {
    const repository = yield* PtyRepository;
    const adapter = yield* PtyAdapter;
    const directory = yield* DataDirectory;
    const liveSessions = new Map<number, LiveSession>();

    mkdirSync(directory.paths.sessionsPath, { recursive: true });
    yield* reportOrphanPtyLogs(repository, directory.paths.sessionsPath);
    yield* recoverStaleSessions(repository);

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

          if (!existsSync(metadata.logPath)) {
            appendLog(metadata.logPath, '');
          }

          const startResult = yield* adapter
            .start({
              command: metadata.command,
              cwd: metadata.cwd,
              env: launchEnv(),
              cols: defaultCols,
              rows: defaultRows,
              onOutput: (data) =>
                appendSessionOutput(
                  repository,
                  liveSessions,
                  metadata.ptySessionId,
                  metadata.logPath,
                  data,
                ),
              onExit: (exit) =>
                void Effect.runPromise(
                  handleExit(repository, liveSessions, metadata.ptySessionId, exit),
                ),
            })
            .pipe(Effect.either);

          if (Either.isLeft(startResult)) {
            const message = spawnFailureMessage(metadata.command, metadata.cwd, startResult.left);
            console.warn(
              `[runtime] PTY launch failed ptySessionId=${metadata.ptySessionId} worktreeId=${metadata.worktreeId} command=${metadata.command}`,
              startResult.left.cause,
            );
            appendSessionOutput(
              repository,
              liveSessions,
              metadata.ptySessionId,
              metadata.logPath,
              message,
            );
            yield* repository.transitionSession({
              ptySessionId: metadata.ptySessionId,
              status: 'failed',
              exitCode: null,
              signal: null,
            });
          } else {
            console.info(
              `[runtime] PTY launch running ptySessionId=${metadata.ptySessionId} worktreeId=${metadata.worktreeId} adapter=${adapter.name}`,
            );
            const live = {
              handle: startResult.right,
              status: 'running' as const,
              logBytes: statSync(metadata.logPath).size,
              pendingLogBytes: false,
              flushTimer: null,
              subscribers: new Set(),
            } satisfies LiveSession;
            yield* repository
              .transitionSession({
                ptySessionId: metadata.ptySessionId,
                status: 'running',
                exitCode: null,
                signal: null,
              })
              .pipe(
                Effect.catchAll((error) =>
                  adapter
                    .kill(startResult.right)
                    .pipe(Effect.ignore, Effect.zipRight(Effect.fail(error))),
                ),
              );
            liveSessions.set(metadata.ptySessionId, live);
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

          const live = liveSessions.get(input.ptySessionId);
          console.info(
            `[runtime] PTY websocket attach ptySessionId=${input.ptySessionId} live=${Boolean(live)}`,
          );
          let unsubscribe = () => {};
          if (live) {
            live.subscribers.add(input.send);
            unsubscribe = () => {
              live.subscribers.delete(input.send);
              console.info(
                `[runtime] PTY websocket detach ptySessionId=${input.ptySessionId} remainingSubscribers=${live.subscribers.size}`,
              );
            };
          }

          const currentSession = live
            ? { ...session, status: live.status, logBytes: live.logBytes }
            : session;

          return {
            session: currentSession,
            replayOffset: currentSession.logBytes,
            live: Boolean(live),
            unsubscribe,
          } satisfies PtyAttachment;
        }),
      replay: (input) => replayLog(input.session.logPath, input.bytes, input.send),
      write: (input) =>
        Effect.gen(function* () {
          const live = liveSessions.get(input.ptySessionId);
          if (!live || live.status !== 'running') {
            return yield* Effect.fail(
              new PtyServiceError({
                code: 'session_not_running',
                message: `PTY session ${input.ptySessionId} is not running.`,
                ptySessionId: input.ptySessionId,
              }),
            );
          }
          yield* adapter.write(live.handle, input.data);
        }),
      resize: (input) =>
        Effect.gen(function* () {
          const live = liveSessions.get(input.ptySessionId);
          if (!live || live.status !== 'running') {
            return yield* Effect.fail(
              new PtyServiceError({
                code: 'session_not_running',
                message: `PTY session ${input.ptySessionId} is not running.`,
                ptySessionId: input.ptySessionId,
              }),
            );
          }
          yield* adapter.resize(live.handle, { cols: input.cols, rows: input.rows });
        }),
    } satisfies PtyService;

    return yield* Effect.acquireRelease(Effect.succeed(service), () =>
      Effect.gen(function* () {
        for (const [ptySessionId, live] of liveSessions) {
          live.status = 'failed';
          const session = yield* repository
            .findSession(ptySessionId)
            .pipe(Effect.orElseSucceed(() => null));
          if (session) {
            appendSessionOutput(
              repository,
              liveSessions,
              ptySessionId,
              session.logPath,
              shutdownNote,
            );
          }
          yield* flushLogBytes(repository, ptySessionId, live).pipe(Effect.ignore);
          yield* adapter.kill(live.handle).pipe(Effect.ignore);
          yield* repository
            .transitionSession({
              ptySessionId,
              status: 'failed',
              exitCode: null,
              signal: null,
            })
            .pipe(Effect.ignore);
        }
        liveSessions.clear();
      }),
    );
  }),
);

function recoverStaleSessions(repository: PtyRepositoryService) {
  return Effect.gen(function* () {
    const sessions = yield* repository.listLivePersistedSessions;
    for (const session of sessions) {
      appendSessionOutput(repository, new Map(), session.id, session.logPath, restartNote);
      yield* repository.transitionSession({
        ptySessionId: session.id,
        status: 'failed',
        exitCode: null,
        signal: null,
      });
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

function normalizePath(path: string) {
  return relative(process.cwd(), path);
}

function relativeSessionLogPath(sessionsPath: string, path: string) {
  const relativePath = relative(sessionsPath, path);
  return relativePath.startsWith('..') ? basename(path) : `sessions/${relativePath}`;
}

function appendSessionOutput(
  repository: PtyRepositoryService,
  liveSessions: Map<number, LiveSession>,
  ptySessionId: number,
  logPath: string,
  data: string,
) {
  try {
    const bytes = appendLog(logPath, data);
    const live = liveSessions.get(ptySessionId);
    if (live) {
      live.logBytes += bytes;
      scheduleLogByteFlush(repository, ptySessionId, live);
    } else {
      Effect.runSync(repository.appendLogBytes({ ptySessionId, bytes }));
    }
    if (live) {
      for (const subscriber of live.subscribers) {
        subscriber({ type: 'output', data });
      }
    }
  } catch (error) {
    console.error(`[runtime] Failed to append PTY output for session ${ptySessionId}`, error);
  }
}

function scheduleLogByteFlush(
  repository: PtyRepositoryService,
  ptySessionId: number,
  live: LiveSession,
) {
  live.pendingLogBytes = true;
  if (live.flushTimer) {
    return;
  }
  live.flushTimer = setTimeout(() => {
    live.flushTimer = null;
    void Effect.runPromise(flushLogBytes(repository, ptySessionId, live));
  }, 250);
}

function flushLogBytes(repository: PtyRepositoryService, ptySessionId: number, live: LiveSession) {
  return Effect.sync(() => {
    if (live.flushTimer) {
      clearTimeout(live.flushTimer);
      live.flushTimer = null;
    }
  }).pipe(
    Effect.zipRight(
      live.pendingLogBytes
        ? repository.setLogBytes({ ptySessionId, bytes: live.logBytes })
        : Effect.void,
    ),
    Effect.tap(() =>
      Effect.sync(() => {
        live.pendingLogBytes = false;
      }),
    ),
  );
}

function handleExit(
  repository: PtyRepositoryService,
  liveSessions: Map<number, LiveSession>,
  ptySessionId: number,
  exit: PtyExit,
) {
  return Effect.gen(function* () {
    const live = liveSessions.get(ptySessionId);
    const status = exit.exitCode === 0 && exit.signal === null ? 'exited' : 'failed';
    console.info(
      `[runtime] PTY exited ptySessionId=${ptySessionId} status=${status} exitCode=${exit.exitCode ?? 'null'} signal=${exit.signal ?? 'null'}`,
    );
    if (live) {
      live.status = status;
      yield* flushLogBytes(repository, ptySessionId, live);
    }
    yield* repository.transitionSession({
      ptySessionId,
      status,
      exitCode: exit.exitCode,
      signal: exit.signal,
    });
    if (live) {
      for (const subscriber of live.subscribers) {
        subscriber({ type: 'exit', exitCode: exit.exitCode, signal: exit.signal });
      }
      liveSessions.delete(ptySessionId);
    }
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        console.error(`[runtime] Failed to persist PTY exit for session ${ptySessionId}`, error);
        scheduleExitPersistenceRetry(repository, liveSessions, ptySessionId, exit);
      }),
    ),
  );
}

function scheduleExitPersistenceRetry(
  repository: PtyRepositoryService,
  liveSessions: Map<number, LiveSession>,
  ptySessionId: number,
  exit: PtyExit,
) {
  const retry = () => {
    void Effect.runPromise(
      Effect.gen(function* () {
        const live = liveSessions.get(ptySessionId);
        if (!live) {
          return;
        }
        const status = exit.exitCode === 0 && exit.signal === null ? 'exited' : 'failed';
        live.status = status;
        yield* flushLogBytes(repository, ptySessionId, live);
        yield* repository.transitionSession({
          ptySessionId,
          status,
          exitCode: exit.exitCode,
          signal: exit.signal,
        });
        for (const subscriber of live.subscribers) {
          subscriber({ type: 'exit', exitCode: exit.exitCode, signal: exit.signal });
        }
        liveSessions.delete(ptySessionId);
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

function replayLog(
  path: string,
  bytes: number,
  send: (message: PtyWebSocketOutputMessage) => void,
) {
  return Effect.try({
    try: () => {
      send({ type: 'replay_start', bytes });
      if (bytes > 0) {
        const fd = openSync(path, 'r');
        try {
          const buffer = Buffer.allocUnsafe(Math.min(replayChunkBytes, bytes));
          let offset = 0;
          while (offset < bytes) {
            const toRead = Math.min(buffer.byteLength, bytes - offset);
            const read = readSync(fd, buffer, 0, toRead, offset);
            if (read <= 0) {
              break;
            }
            offset += read;
            send({ type: 'output', data: buffer.toString('utf8', 0, read), replay: true });
          }
        } finally {
          closeSync(fd);
        }
      }
      send({ type: 'replay_end' });
    },
    catch: (cause) =>
      new PtyServiceError({
        code: 'log_read_failed',
        message: 'Could not replay this session log.',
        cause,
      }),
  });
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

function spawnFailureMessage(command: string, cwd: string, error: PtyStartError) {
  const reason =
    error.cause instanceof Error && error.cause.message ? error.cause.message : String(error.cause);
  return `\r\nFailed to start ${command} in ${cwd}: ${reason}\r\n`;
}
