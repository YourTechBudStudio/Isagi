import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import process from 'node:process';

import { Context, Effect, Either, Layer, Schema } from 'effect';

import type { LaunchSessionOutput, PtyWebSocketOutputMessage } from '@isagi/contracts';

import { DataDirectory, DatabaseError } from '../persistence/index.js';
import type { PtySessionRow } from '../surfaces/index.js';
import { PtyBackend } from './node-pty.adapter.js';
import {
  appendLog,
  MissingLaunchWorktree,
  PtyRepository,
  type PtyRepositoryService,
} from './pty.repository.js';
import {
  PtyResizeError,
  PtyServiceError,
  PtyStartError,
  PtyWriteError,
  type BackendAttachment,
  type BackendSessionRef,
  type LaunchPtySessionInput,
  type PtyExit,
  type PtySessionLaunchMetadata,
} from './types.js';

const defaultCols = 100;
const defaultRows = 30;
const orphanLogSampleSize = 5;

const nodePtyBackendRefSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  backend: Schema.Literal('node_pty'),
  ptySessionId: Schema.Number.pipe(Schema.int(), Schema.positive()),
  pid: Schema.NullOr(Schema.Number.pipe(Schema.int())),
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
    const backend = yield* PtyBackend;
    const directory = yield* DataDirectory;
    const activeAttachments = new Map<number, ActiveAttachment>();

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

          if (metadata.logPath && !existsSync(metadata.logPath)) {
            appendLog(metadata.logPath, '');
          }

          const startResult = yield* backend
            .launch({
              ptySessionId: metadata.ptySessionId,
              command: metadata.command,
              cwd: metadata.cwd,
              env: launchEnv(),
              cols: defaultCols,
              rows: defaultRows,
              logPath: metadata.logPath,
              onExit: (exit) =>
                void Effect.runPromise(
                  handleExit(repository, activeAttachments, metadata.ptySessionId, exit),
                ),
            })
            .pipe(Effect.either);

          if (Either.isLeft(startResult)) {
            const message = spawnFailureMessage(metadata.command, metadata.cwd, startResult.left);
            console.warn(
              `[runtime] PTY launch failed ptySessionId=${metadata.ptySessionId} worktreeId=${metadata.worktreeId} command=${metadata.command}`,
              startResult.left.cause,
            );
            if (metadata.logPath) {
              appendLog(metadata.logPath, message);
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
              `[runtime] PTY launch running ptySessionId=${metadata.ptySessionId} worktreeId=${metadata.worktreeId} backend=${backend.name}`,
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
          yield* detachActiveAttachment(activeAttachments, session.id);
          const attachResult = yield* backend
            .attach({
              ref,
              cols: defaultCols,
              rows: defaultRows,
              onOutput: (data) => input.send({ type: 'output', data }),
              onExit: (exit) => input.send({ type: 'exit', ...exit }),
            })
            .pipe(Effect.either);

          if (Either.isLeft(attachResult)) {
            yield* repository.transitionSession({
              ptySessionId: session.id,
              status: 'failed',
              statusReason: 'runtime_ephemeral_lost',
              exitCode: null,
              signal: null,
            });
            return yield* Effect.fail(
              new PtyServiceError({
                code: 'backend_session_missing',
                message: `PTY session ${session.id} is missing its runtime-local backend session.`,
                ptySessionId: session.id,
                cause: attachResult.left,
              }),
            );
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
        const sessions = yield* repository.listLivePersistedSessions.pipe(
          Effect.orElseSucceed(() => []),
        );
        for (const active of activeAttachments.values()) {
          yield* active.attachment.detach;
        }
        activeAttachments.clear();
        for (const session of sessions) {
          const ref = yield* decodeBackendRef(session).pipe(Effect.orElseSucceed(() => null));
          if (ref) {
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

function recoverStaleSessions(repository: PtyRepositoryService) {
  return Effect.gen(function* () {
    const sessions = yield* repository.listLivePersistedSessions;
    for (const session of sessions) {
      if (session.backend !== 'node_pty') {
        continue;
      }
      yield* repository.transitionSession({
        ptySessionId: session.id,
        status: 'failed',
        statusReason: 'runtime_ephemeral_lost',
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
      const ref = Schema.decodeUnknownSync(nodePtyBackendRefSchema)(
        JSON.parse(session.backendRefJson),
      );
      if (ref.ptySessionId !== session.id) {
        throw new Error(
          `Backend ref ptySessionId ${ref.ptySessionId} does not match row id ${session.id}.`,
        );
      }
      return ref;
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

function spawnFailureMessage(command: string, cwd: string, error: PtyStartError) {
  const reason =
    error.cause instanceof Error && error.cause.message ? error.cause.message : String(error.cause);
  return `\r\nFailed to start ${command} in ${cwd}: ${reason}\r\n`;
}
