import { existsSync, mkdirSync } from 'node:fs';

import { Context, Effect, Either, Layer } from 'effect';

import type { PtyWebSocketOutputMessage, SurfaceDeleteWarning } from '@isagi/contracts';

import { DataDirectory, DatabaseError } from '../persistence/index.js';
import {
  InternalRuntimeEventBus,
  type InternalRuntimeEventBusService,
} from '../runtime-events/index.js';
import type { PtySessionRow } from '../surfaces/index.js';
import { PtyBackend } from './backend.js';
import { appendLog, PtyRepository, type PtyRepositoryService } from './pty.repository.js';
import {
  detachActiveAttachment,
  requireActiveAttachment,
  type ActiveAttachment,
} from './service/attachments.js';
import { backendMetadataForLaunch, decodeBackendRef } from './service/backend-ref.js';
import { transitionSessionAndPublish, transitionSessionByIdAndPublish } from './service/events.js';
import { runPtyGc, startPtyGcLoop } from './service/gc.js';
import { handleExit, type PtyTerminationState } from './service/lifecycle.js';
import {
  replayBytesForSession,
  replaySessionLog,
  reportOrphanPtyLogs,
  startOrphanPtyLogGcLoop,
} from './service/logs.js';
import { launchEnv, runtimeNamespace, spawnFailureMessage } from './service/runtime-namespace.js';
import {
  terminatePtySessionAndPersistKilled,
  terminatePtySessionForDelete,
} from './service/termination.js';
import {
  PtyKillError,
  PtyResizeError,
  PtyServiceError,
  PtyWriteError,
  type BackendSessionRef,
  type LaunchPtyProcessInput,
  type PtyBackend as PtyBackendShape,
  type PtyProcessLaunchMetadata,
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

export interface PtyAttachmentPlan {
  readonly session: PtySessionRow;
  readonly replayBytes: number | null;
  readonly live: boolean;
  readonly replaySource: 'backend' | 'file_log';
}

export interface PtyService {
  readonly launch: (
    input: LaunchPtyProcessInput,
  ) => Effect.Effect<PtyProcessLaunchMetadata, PtyLaunchError>;
  readonly getAttachmentPlan: (input: {
    readonly ptySessionId: number;
  }) => Effect.Effect<PtyAttachmentPlan, PtyAttachError>;
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
  readonly cleanupProcessForDelete: (input: {
    readonly ptyProcessId: number;
    readonly paneId: number;
    readonly session: SurfaceDeleteWarning['session'];
  }) => Effect.Effect<SurfaceDeleteWarning[], DatabaseError>;
  // Compatibility method used by some old tests/callers during the folder rename.
  readonly cleanupSessionForDelete: (input: {
    readonly ptySessionId: number;
    readonly paneId: number;
  }) => Effect.Effect<SurfaceDeleteWarning[], DatabaseError>;
}

export const PtyService = Context.GenericTag<PtyService>('isagi/PtyProcessService');

export const PtyServiceLive = Layer.scoped(
  PtyService,
  Effect.gen(function* () {
    const repository = yield* PtyRepository;
    const backend = yield* PtyBackend;
    const directory = yield* DataDirectory;
    const eventBus = yield* InternalRuntimeEventBus;
    const activeAttachments = new Map<number, ActiveAttachment>();
    const pendingAttachments = new Set<number>();
    const terminations = new Map<number, PtyTerminationState>();
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
          console.info(
            `[runtime] PTY process launch starting command=${input.command} cwd=${input.cwd}`,
          );
          const ptyProcessId = yield* repository.createProcessMetadata({
            command: input.command,
            args: input.args,
            cwd: input.cwd,
          });
          const metadata: PtyProcessLaunchMetadata = {
            ptyProcessId,
            command: input.command,
            args: input.args,
            cwd: input.cwd,
            logPath: null,
          };
          const startResult = yield* launchWithBackend({
            backend,
            metadata,
            repository,
            activeAttachments,
            runtimeNamespace: namespace,
            sessionsPath: directory.paths.sessionsPath,
            terminations,
            eventBus,
            env: input.envForProcess
              ? yield* input.envForProcess({ ptyProcessId: metadata.ptyProcessId })
              : (input.env ?? launchEnv()),
          }).pipe(Effect.either);
          if (Either.isLeft(startResult)) {
            const message = spawnFailureMessage(metadata.command, metadata.cwd, startResult.left);
            console.warn(
              `[runtime] PTY process launch failed ptyProcessId=${metadata.ptyProcessId} command=${metadata.command}`,
              startResult.left,
            );
            const failedProcess = yield* repository
              .findSession(metadata.ptyProcessId)
              .pipe(Effect.orElseSucceed(() => null));
            if (failedProcess?.logPath) appendLog(failedProcess.logPath, message);
            yield* transitionSessionByIdAndPublish(repository, eventBus, {
              ptySessionId: metadata.ptyProcessId,
              status: 'failed',
              statusReason: 'backend_launch_failed',
              exitCode: null,
              signal: null,
            });
          } else {
            yield* repository
              .updateBackendRef({
                ptySessionId: metadata.ptyProcessId,
                backendRefJson: JSON.stringify(startResult.right),
              })
              .pipe(
                Effect.zipRight(
                  transitionSessionByIdAndPublish(repository, eventBus, {
                    ptySessionId: metadata.ptyProcessId,
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
          const row = yield* repository.findSession(metadata.ptyProcessId);
          return { ...metadata, logPath: row?.logPath ?? null } satisfies PtyProcessLaunchMetadata;
        }),
      getAttachmentPlan: (input) => getAttachmentPlan(repository, backend, input.ptySessionId),
      attach: (input) =>
        attachToProcess(
          repository,
          backend,
          eventBus,
          activeAttachments,
          pendingAttachments,
          input,
        ),
      replay: (input) => replayProcess(backend, input),
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
        terminatePtySessionAndPersistKilled({
          repository,
          backend,
          eventBus,
          activeAttachments,
          terminations,
          ptySessionId: input.ptySessionId,
          reason: 'user_requested',
        }),
      cleanupProcessForDelete: (input) =>
        terminatePtySessionForDelete({
          repository,
          backend,
          eventBus,
          activeAttachments,
          terminations,
          ptySessionId: input.ptyProcessId,
          paneId: input.paneId,
          session: input.session,
        }),
      cleanupSessionForDelete: (input) =>
        terminatePtySessionForDelete({
          repository,
          backend,
          eventBus,
          activeAttachments,
          terminations,
          ptySessionId: input.ptySessionId,
          paneId: input.paneId,
          session: { kind: 'terminal_session', terminalSessionId: input.ptySessionId },
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
        for (const active of activeAttachments.values()) yield* active.attachment.detach;
        activeAttachments.clear();
        for (const session of sessions) {
          if (session.backend !== 'node_pty') continue;
          yield* terminatePtySessionAndPersistKilled({
            repository,
            backend,
            eventBus,
            activeAttachments,
            terminations,
            ptySessionId: session.id,
            reason: 'runtime_shutdown',
            killFailurePolicy: 'persist_killed',
          }).pipe(Effect.ignore);
        }
      }),
    );
  }),
);

function attachToProcess(
  repository: PtyRepositoryService,
  backend: PtyBackendShape,
  eventBus: InternalRuntimeEventBusService,
  activeAttachments: Map<number, ActiveAttachment>,
  pendingAttachments: Set<number>,
  input: {
    readonly ptySessionId: number;
    readonly send: (message: PtyWebSocketOutputMessage) => void;
  },
) {
  return Effect.gen(function* () {
    const plan = yield* getAttachmentPlan(repository, backend, input.ptySessionId);
    if (!plan.live)
      return {
        session: plan.session,
        attachmentId: null,
        replayBytes: plan.replayBytes,
        live: false,
        unsubscribe: () => {},
      } satisfies PtyAttachment;
    const session = plan.session;
    const ref = yield* decodeBackendRef(session);
    if (activeAttachments.has(session.id) || pendingAttachments.has(session.id)) {
      return yield* Effect.fail(
        new PtyServiceError({
          code: 'session_already_attached',
          message: `PTY process ${session.id} already has an active websocket attachment.`,
          ptySessionId: session.id,
        }),
      );
    }
    pendingAttachments.add(session.id);
    return yield* Effect.gen(function* () {
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
            message: `Could not attach to PTY process ${session.id}.`,
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
      return {
        session,
        attachmentId,
        replayBytes: plan.replayBytes,
        live: true,
        unsubscribe: () => {
          void Effect.runPromise(
            detachActiveAttachment(activeAttachments, session.id, attachmentId),
          );
        },
      } satisfies PtyAttachment;
    }).pipe(Effect.ensuring(Effect.sync(() => pendingAttachments.delete(session.id))));
  });
}

function replayProcess(
  backend: PtyBackendShape,
  input: {
    readonly session: PtySessionRow;
    readonly bytes: number | null;
    readonly send: (message: PtyWebSocketOutputMessage) => void;
  },
) {
  return Effect.gen(function* () {
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
    if (input.session.backend !== backend.name)
      return yield* Effect.fail(
        new PtyServiceError({
          code: 'backend_unavailable',
          message: `PTY backend ${input.session.backend} is not active in this runtime process.`,
          ptySessionId: input.session.id,
        }),
      );
    yield* backend.replay({
      ref,
      logPath: input.session.logPath,
      bytes: input.bytes,
      send: input.send,
    });
  });
}

function getAttachmentPlan(
  repository: PtyRepositoryService,
  backend: PtyBackendShape,
  ptySessionId: number,
) {
  return Effect.gen(function* () {
    const session = yield* repository.findSession(ptySessionId);
    if (!session)
      return yield* Effect.fail(
        new PtyServiceError({
          code: 'session_not_found',
          message: `PTY process ${ptySessionId} was not found.`,
          ptySessionId,
        }),
      );
    const live = session.status === 'running';
    if (live && session.backend !== backend.name)
      return yield* Effect.fail(
        new PtyServiceError({
          code: 'backend_unavailable',
          message: `PTY backend ${session.backend} is not active in this runtime process.`,
          ptySessionId: session.id,
        }),
      );
    return {
      session,
      replayBytes: replayBytesForSession(session),
      live,
      replaySource: session.logMode === 'backend_file' ? 'file_log' : 'backend',
    } satisfies PtyAttachmentPlan;
  });
}

function startStatusPolling(
  repository: PtyRepositoryService,
  backend: PtyBackendShape,
  eventBus: InternalRuntimeEventBusService,
) {
  const timer = setInterval(() => {
    void Effect.runPromise(
      reconcilePersistedSessions(repository, backend, eventBus, { startup: false }).pipe(
        Effect.catchAll((error) =>
          Effect.sync(() => console.warn('[runtime] PTY status polling failed', error)),
        ),
      ),
    );
  }, statusPollIntervalMs);
  timer.unref();
  return timer;
}

function reconcilePersistedSessions(
  repository: PtyRepositoryService,
  backend: PtyBackendShape,
  eventBus: InternalRuntimeEventBusService,
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
          statusReason: 'backend_process_missing',
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
          yield* transitionIfChanged(repository, eventBus, session, {
            status: 'failed',
            statusReason:
              session.backend === 'node_pty' ? 'runtime_ephemeral_lost' : 'backend_process_missing',
          });
          break;
      }
    }
  });
}

function launchWithBackend(input: {
  readonly backend: PtyBackendShape;
  readonly metadata: PtyProcessLaunchMetadata;
  readonly repository: PtyRepositoryService;
  readonly activeAttachments: Map<number, ActiveAttachment>;
  readonly runtimeNamespace: string;
  readonly sessionsPath: string;
  readonly terminations: Map<number, PtyTerminationState>;
  readonly eventBus: InternalRuntimeEventBusService;
  readonly env: NodeJS.ProcessEnv;
}) {
  return Effect.gen(function* () {
    const compat = {
      worktreeId: 0,
      surfaceId: 0,
      paneId: 0,
      ptySessionId: input.metadata.ptyProcessId,
      command: input.metadata.command,
      cwd: input.metadata.cwd,
      logPath: input.metadata.logPath,
    };
    const backendMetadata = backendMetadataForLaunch(
      input.backend,
      compat,
      input.runtimeNamespace,
      input.sessionsPath,
    );
    if (backendMetadata.logPath && !existsSync(backendMetadata.logPath))
      appendLog(backendMetadata.logPath, '');
    yield* input.repository.updateBackendMetadata({
      ptySessionId: input.metadata.ptyProcessId,
      backend: input.backend.name,
      backendRefJson: JSON.stringify(backendMetadata.ref),
      logMode: backendMetadata.logMode,
      logPath: backendMetadata.logPath,
    });
    const startResult = yield* input.backend.launch({
      ptySessionId: input.metadata.ptyProcessId,
      backendSessionName: backendMetadata.backendSessionName,
      command: input.metadata.command,
      args: input.metadata.args,
      cwd: input.metadata.cwd,
      env: input.env,
      cols: defaultCols,
      rows: defaultRows,
      logPath: backendMetadata.logPath,
      onExit: (exit) =>
        void Effect.runPromise(
          handleExit(
            input.repository,
            input.eventBus,
            input.activeAttachments,
            input.terminations,
            input.metadata.ptyProcessId,
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
  eventBus: InternalRuntimeEventBusService,
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
        statusReason: 'backend_process_missing',
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
  eventBus: InternalRuntimeEventBusService,
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
  )
    return Effect.void;
  return transitionSessionAndPublish(repository, eventBus, session, {
    ptySessionId: session.id,
    status: next.status,
    statusReason: next.statusReason,
    exitCode: next.status === 'running' ? null : session.exitCode,
    signal: next.status === 'running' ? null : session.signal,
    ...(lastSeenAt !== undefined ? { lastSeenAt } : {}),
  });
}
