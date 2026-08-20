import { existsSync, mkdirSync } from 'node:fs';

import { Context, Effect, Either, Layer } from 'effect';

import type { PtyStreamOutputMessageSet } from '@isagi/contracts';

import { UserShell } from '../host-inventory/user-shell.service.js';
import { DataDirectory, DatabaseError } from '../persistence/index.js';
import {
  InternalRuntimeEventBus,
  type InternalRuntimeEventBusService,
} from '../runtime-events/index.js';
import type { PtyProcessRecord } from '../surfaces/index.js';
import { PtyBackendCatalog, type PtyBackendCatalogService } from './backend.js';
import { PtyForegroundState, type PtyForegroundStateService } from './foreground-state.js';
import { appendLog, PtyRepository, type PtyRepositoryService } from './pty.repository.js';
import {
  detachActiveAttachment,
  requireActiveAttachment,
  type ActiveAttachment,
} from './service/attachments.js';
import { backendMetadataForLaunch, decodeBackendRef } from './service/backend-ref.js';
import { transitionProcessAndPublish, transitionProcessByIdAndPublish } from './service/events.js';
import { collectPtyGarbage, startPtyGarbageCollector } from './service/gc.js';
import { backendLaunchCommand } from './service/launch-mode.js';
import { handleExit, type PtyTerminationState } from './service/lifecycle.js';
import { replayBytesForProcess, replayProcessLog, reportOrphanPtyLogs } from './service/logs.js';
import { launchEnv, runtimeNamespace, spawnFailureMessage } from './service/runtime-namespace.js';
import {
  prepareShellIntegration,
  refWithShellIntegrationToken,
} from './service/shell-integration.js';
import type { ShellIntegrationConfig } from './service/shell-integration.js';
import { terminatePtyProcessAndPersistKilled } from './service/termination.js';
import {
  PtyKillError,
  PtyResizeError,
  PtyServiceError,
  PtyWriteError,
  type BackendSessionRef,
  type LaunchPtyProcessInput,
  type PtyBackend as PtyBackendShape,
  type PtyForegroundCommandState,
  type PtyProcessLaunchMetadata,
} from './types.js';

const defaultCols = 100;
const defaultRows = 30;
const statusPollIntervalMs = 10_000;

export type PtyLaunchError = DatabaseError | PtyServiceError;
export type PtyAttachError = DatabaseError | PtyServiceError;
export type PtyInputError = DatabaseError | PtyServiceError | PtyWriteError | PtyResizeError;
export type PtyKillProcessError = DatabaseError | PtyServiceError | PtyKillError;
export type PtyAttachmentMode = 'interactive' | 'read_only';

export interface PtyAttachment {
  readonly session: PtyProcessRecord;
  readonly attachmentId: symbol | null;
  readonly replayBytes: number | null;
  readonly live: boolean;
  readonly detach: Effect.Effect<void, never>;
  readonly unsubscribe: () => void;
}

export interface PtyAttachmentPlan {
  readonly session: PtyProcessRecord;
  readonly replayBytes: number | null;
  readonly live: boolean;
  readonly replaySource: 'backend' | 'file_log';
}

export interface PtyService {
  readonly launch: (
    input: LaunchPtyProcessInput,
  ) => Effect.Effect<PtyProcessLaunchMetadata, PtyLaunchError>;
  readonly getAttachmentPlan: (input: {
    readonly ptyProcessId: number;
  }) => Effect.Effect<PtyAttachmentPlan, PtyAttachError>;
  readonly attach: (input: {
    readonly ptyProcessId: number;
    readonly mode: PtyAttachmentMode;
    readonly supersede?: boolean | undefined;
    readonly displace?:
      | ((attachment: PtyAttachment) => Effect.Effect<void, never> | undefined)
      | undefined;
    readonly send: (message: PtyStreamOutputMessageSet) => void;
  }) => Effect.Effect<PtyAttachment, PtyAttachError>;
  readonly replay: (input: {
    readonly session: PtyProcessRecord;
    readonly bytes: number | null;
    readonly send: (message: PtyStreamOutputMessageSet) => void;
  }) => Effect.Effect<void, PtyAttachError>;
  readonly write: (input: {
    readonly ptyProcessId: number;
    readonly attachmentId: symbol | null;
    readonly data: string;
  }) => Effect.Effect<void, PtyInputError>;
  readonly writeInput: (input: {
    readonly ptyProcessId: number;
    readonly data: string;
  }) => Effect.Effect<void, PtyInputError>;
  readonly resize: (input: {
    readonly ptyProcessId: number;
    readonly attachmentId: symbol | null;
    readonly cols: number;
    readonly rows: number;
  }) => Effect.Effect<void, PtyInputError>;
  readonly kill: (input: {
    readonly ptyProcessId: number;
  }) => Effect.Effect<void, PtyKillProcessError>;
  readonly terminate: (input: {
    readonly ptyProcessId: number;
    readonly gracefulTimeoutMs: number;
  }) => Effect.Effect<void, PtyKillProcessError>;
  readonly pin: (input: { readonly ptyProcessId: number }) => Effect.Effect<void>;
  readonly unpin: (input: { readonly ptyProcessId: number }) => Effect.Effect<void>;
  readonly isPinned: (input: { readonly ptyProcessId: number }) => Effect.Effect<boolean>;
}

export const PtyService = Context.GenericTag<PtyService>('isagi/PtyProcessService');

export const PtyServiceLive = Layer.scoped(
  PtyService,
  Effect.gen(function* () {
    const repository = yield* PtyRepository;
    const catalog = yield* PtyBackendCatalog;
    const foreground = yield* PtyForegroundState;
    const directory = yield* DataDirectory;
    const eventBus = yield* InternalRuntimeEventBus;
    const userShell = yield* UserShell;
    const userProcessEnvironment = launchEnv(userShell.environment.values);
    const activeAttachments = new Map<number, ActiveAttachment>();
    const pendingAttachments = new Set<number>();
    const pinnedPtyProcessIds = new Set<number>();
    const terminations = new Map<number, PtyTerminationState>();
    const namespace = runtimeNamespace(directory.paths.root);

    mkdirSync(directory.paths.sessionsPath, { recursive: true });
    yield* reportOrphanPtyLogs(repository, directory.paths.sessionsPath);
    yield* reconcilePersistedProcesses(repository, catalog, eventBus, { startup: true });
    yield* collectPtyGarbage(repository, catalog, namespace, directory.paths.sessionsPath, {
      pinnedPtyProcessIds,
    });
    const pollTimer = startStatusPolling(repository, catalog, eventBus);
    const gcTimer = startPtyGarbageCollector(
      repository,
      catalog,
      namespace,
      directory.paths.sessionsPath,
      { pinnedPtyProcessIds },
    );

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
          yield* foreground.clear(ptyProcessId);
          const processEnvironment: NodeJS.ProcessEnv = {
            ...userProcessEnvironment,
            ...input.envOverrides,
            ...(input.envForProcess
              ? yield* input.envForProcess({ ptyProcessId: metadata.ptyProcessId })
              : {}),
          };
          const backendCommand = backendLaunchCommand({
            launch: input,
            env: processEnvironment,
          });
          const launch = prepareShellIntegration({
            launch: {
              ...input,
              command: backendCommand.command,
              args: backendCommand.args,
              launchMode: 'direct',
            },
            ptyProcessId,
            sessionsPath: directory.paths.sessionsPath,
            env: processEnvironment,
          });
          const startResult = yield* launchWithBackend({
            backend: catalog.configured,
            metadata: {
              ...metadata,
              command: launch.command,
              args: launch.args,
            },
            repository,
            activeAttachments,
            runtimeNamespace: namespace,
            sessionsPath: directory.paths.sessionsPath,
            terminations,
            eventBus,
            foreground,
            shellIntegration: launch.shellIntegration,
            env: launch.env,
          }).pipe(Effect.either);
          if (Either.isLeft(startResult)) {
            const message = spawnFailureMessage(metadata.command, metadata.cwd, startResult.left);
            console.warn(
              `[runtime] PTY process launch failed ptyProcessId=${metadata.ptyProcessId} command=${metadata.command}`,
              startResult.left,
            );
            const failedProcess = yield* repository
              .findProcess(metadata.ptyProcessId)
              .pipe(Effect.orElseSucceed(() => null));
            if (failedProcess?.logPath) appendLog(failedProcess.logPath, message);
            yield* transitionProcessByIdAndPublish(repository, eventBus, {
              ptyProcessId: metadata.ptyProcessId,
              status: 'failed',
              statusReason: 'backend_launch_failed',
              exitCode: null,
              signal: null,
            });
          } else {
            yield* repository
              .updateBackendRef({
                ptyProcessId: metadata.ptyProcessId,
                backendRefJson: JSON.stringify(startResult.right),
              })
              .pipe(
                Effect.zipRight(
                  transitionProcessByIdAndPublish(repository, eventBus, {
                    ptyProcessId: metadata.ptyProcessId,
                    status: 'running',
                    statusReason: null,
                    exitCode: null,
                    signal: null,
                  }),
                ),
                Effect.catchAll((error) =>
                  catalog.configured
                    .kill(startResult.right)
                    .pipe(Effect.ignore, Effect.zipRight(Effect.fail(error))),
                ),
              );
          }
          const row = yield* repository.findProcess(metadata.ptyProcessId);
          return { ...metadata, logPath: row?.logPath ?? null } satisfies PtyProcessLaunchMetadata;
        }),
      getAttachmentPlan: (input) => getAttachmentPlan(repository, catalog, input.ptyProcessId),
      attach: (input) =>
        attachToProcess(
          repository,
          catalog,
          eventBus,
          foreground,
          activeAttachments,
          pendingAttachments,
          input,
        ),
      replay: (input) => replayProcess(catalog, input),
      write: (input) =>
        Effect.gen(function* () {
          const active = yield* requireActiveAttachment(
            activeAttachments,
            input.ptyProcessId,
            input.attachmentId,
          );
          yield* active.attachment.write(input.data);
        }),
      writeInput: (input) =>
        Effect.gen(function* () {
          const plan = yield* getAttachmentPlan(repository, catalog, input.ptyProcessId);
          if (!plan.live) {
            return yield* Effect.fail(
              new PtyServiceError({
                code: 'session_not_running',
                message: `PTY process ${input.ptyProcessId} is not running.`,
                ptyProcessId: input.ptyProcessId,
              }),
            );
          }
          const ref = yield* decodeBackendRef(plan.session);
          // `getAttachmentPlan` already probed this row's adapter; re-checking
          // availability here would only buy a second `tmux -V`.
          yield* catalog.forBackend(plan.session.backend).writeInput({ ref, data: input.data });
        }),
      resize: (input) =>
        Effect.gen(function* () {
          const active = yield* requireActiveAttachment(
            activeAttachments,
            input.ptyProcessId,
            input.attachmentId,
          );
          yield* active.attachment.resize({ cols: input.cols, rows: input.rows });
        }),
      kill: (input) =>
        terminatePtyProcessAndPersistKilled({
          repository,
          catalog,
          eventBus,
          activeAttachments,
          terminations,
          ptyProcessId: input.ptyProcessId,
          reason: 'user_requested',
        }),
      terminate: (input) =>
        terminatePtyProcessAndPersistKilled({
          repository,
          catalog,
          eventBus,
          activeAttachments,
          terminations,
          ptyProcessId: input.ptyProcessId,
          reason: 'user_requested',
          gracefulTimeoutMs: input.gracefulTimeoutMs,
        }),
      pin: (input) =>
        Effect.sync(() => {
          pinnedPtyProcessIds.add(input.ptyProcessId);
        }),
      unpin: (input) =>
        Effect.sync(() => {
          pinnedPtyProcessIds.delete(input.ptyProcessId);
        }),
      isPinned: (input) => Effect.sync(() => pinnedPtyProcessIds.has(input.ptyProcessId)),
    } satisfies PtyService;

    return yield* Effect.acquireRelease(Effect.succeed(service), () =>
      Effect.gen(function* () {
        clearInterval(pollTimer);
        clearInterval(gcTimer);
        const sessions = yield* repository
          .listProcesses({ statuses: ['starting', 'running'] })
          .pipe(Effect.orElseSucceed(() => []));
        for (const active of activeAttachments.values()) yield* active.attachment.detach;
        activeAttachments.clear();
        for (const session of sessions) {
          if (session.backend !== 'node_pty') continue;
          yield* terminatePtyProcessAndPersistKilled({
            repository,
            catalog,
            eventBus,
            activeAttachments,
            terminations,
            ptyProcessId: session.id,
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
  catalog: PtyBackendCatalogService,
  eventBus: InternalRuntimeEventBusService,
  foreground: PtyForegroundStateService,
  activeAttachments: Map<number, ActiveAttachment>,
  pendingAttachments: Set<number>,
  input: {
    readonly ptyProcessId: number;
    readonly mode: PtyAttachmentMode;
    readonly supersede?: boolean | undefined;
    readonly displace?:
      | ((attachment: PtyAttachment) => Effect.Effect<void, never> | undefined)
      | undefined;
    readonly send: (message: PtyStreamOutputMessageSet) => void;
  },
) {
  return Effect.gen(function* () {
    const plan = yield* getAttachmentPlan(repository, catalog, input.ptyProcessId);
    if (!plan.live)
      return {
        session: plan.session,
        attachmentId: null,
        replayBytes: plan.replayBytes,
        live: false,
        detach: Effect.void,
        unsubscribe: () => {},
      } satisfies PtyAttachment;
    const session = plan.session;
    const ref = yield* decodeBackendRef(session);
    // The plan already probed this row's adapter for availability.
    const backend = catalog.forBackend(session.backend);
    if (activeAttachments.has(session.id) || pendingAttachments.has(session.id)) {
      const active = activeAttachments.get(session.id);
      if (input.supersede && active && !pendingAttachments.has(session.id)) {
        if (!active.displace) {
          return yield* Effect.fail(
            new PtyServiceError({
              code: 'session_already_attached',
              message: `PTY process ${session.id} already has an active websocket attachment.`,
              ptyProcessId: session.id,
            }),
          );
        }
        yield* active.displace;
      } else {
        return yield* Effect.fail(
          new PtyServiceError({
            code: 'session_already_attached',
            message: `PTY process ${session.id} already has an active websocket attachment.`,
            ptyProcessId: session.id,
          }),
        );
      }
    }
    if (activeAttachments.has(session.id) || pendingAttachments.has(session.id)) {
      return yield* Effect.fail(
        new PtyServiceError({
          code: 'session_already_attached',
          message: `PTY process ${session.id} already has an active websocket attachment.`,
          ptyProcessId: session.id,
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
          onForegroundCommand: (event) =>
            void Effect.runPromise(
              recordForegroundCommandState(foreground, eventBus, event.ptyProcessId, event.state),
            ),
          onSessionExit: (exit) => input.send({ type: 'exit', ...exit }),
        })
        .pipe(Effect.either);
      if (Either.isLeft(attachResult)) {
        yield* handleAttachFailure(repository, backend, eventBus, session, ref);
        return yield* Effect.fail(
          new PtyServiceError({
            code: 'backend_attach_failed',
            message: `Could not attach to PTY process ${session.id}.`,
            ptyProcessId: session.id,
            cause: attachResult.left,
          }),
        );
      }
      if (session.statusReason === 'backend_unavailable') {
        yield* transitionProcessAndPublish(repository, eventBus, session, {
          ptyProcessId: session.id,
          status: 'running',
          statusReason: null,
          exitCode: session.exitCode,
          signal: session.signal,
        });
      }
      const attachmentId = Symbol(`pty-attachment-${session.id}`);
      const detach = detachActiveAttachment(activeAttachments, session.id, attachmentId);
      const ptyAttachment = {
        session,
        attachmentId: input.mode === 'interactive' ? attachmentId : null,
        replayBytes: attachResult.right.replayBytes,
        live: true,
        detach,
        unsubscribe: () => {
          void Effect.runPromise(detach);
        },
      } satisfies PtyAttachment;
      activeAttachments.set(session.id, {
        ptyProcessId: session.id,
        attachmentId,
        attachment: attachResult.right,
        displace: input.displace?.(ptyAttachment),
      });
      return ptyAttachment;
    }).pipe(Effect.ensuring(Effect.sync(() => pendingAttachments.delete(session.id))));
  });
}

function replayProcess(
  catalog: PtyBackendCatalogService,
  input: {
    readonly session: PtyProcessRecord;
    readonly bytes: number | null;
    readonly send: (message: PtyStreamOutputMessageSet) => void;
  },
) {
  return Effect.gen(function* () {
    if (input.session.logMode === 'backend_file') {
      yield* replayProcessLog({
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
    const backend = catalog.forBackend(input.session.backend);
    if (!(yield* backend.available))
      return yield* Effect.fail(
        new PtyServiceError({
          code: 'backend_unavailable',
          message: `PTY backend ${input.session.backend} is unavailable.`,
          ptyProcessId: input.session.id,
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
  catalog: PtyBackendCatalogService,
  ptyProcessId: number,
) {
  return Effect.gen(function* () {
    const session = yield* repository.findProcess(ptyProcessId);
    if (!session)
      return yield* Effect.fail(
        new PtyServiceError({
          code: 'session_not_found',
          message: `PTY process ${ptyProcessId} was not found.`,
          ptyProcessId,
        }),
      );
    const live = session.status === 'running';
    // Only a live row needs a transport. A dead row still plans a file-log
    // replay, so it must never pay an availability probe. This one check also
    // covers the attach and `writeInput` paths that plan first.
    if (live && !(yield* catalog.forBackend(session.backend).available))
      return yield* Effect.fail(
        new PtyServiceError({
          code: 'backend_unavailable',
          message: `PTY backend ${session.backend} is unavailable.`,
          ptyProcessId: session.id,
        }),
      );
    return {
      session,
      replayBytes: replayBytesForProcess(session),
      live,
      replaySource: session.logMode === 'backend_file' ? 'file_log' : 'backend',
    } satisfies PtyAttachmentPlan;
  });
}

function startStatusPolling(
  repository: PtyRepositoryService,
  catalog: PtyBackendCatalogService,
  eventBus: InternalRuntimeEventBusService,
) {
  const timer = setInterval(() => {
    void Effect.runPromise(
      reconcilePersistedProcesses(repository, catalog, eventBus, { startup: false }).pipe(
        Effect.catchAll((error) =>
          Effect.sync(() => console.warn('[runtime] PTY status polling failed', error)),
        ),
      ),
    );
  }, statusPollIntervalMs);
  timer.unref();
  return timer;
}

function reconcilePersistedProcesses(
  repository: PtyRepositoryService,
  catalog: PtyBackendCatalogService,
  eventBus: InternalRuntimeEventBusService,
  options: { readonly startup: boolean },
) {
  return Effect.gen(function* () {
    const sessions = yield* repository.listProcesses({ statuses: ['starting', 'running'] });
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
      // No availability pre-check: `inspect` already answers
      // alive | missing | unavailable, so probing first would only add a second
      // round-trip to the same backend on every poll.
      const inspection = yield* catalog
        .forBackend(session.backend)
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
  readonly foreground: PtyForegroundStateService;
  readonly shellIntegration: ShellIntegrationConfig | null;
  readonly env: NodeJS.ProcessEnv;
}) {
  return Effect.gen(function* () {
    const backendMetadata = backendMetadataForLaunch(
      input.backend,
      input.metadata,
      input.runtimeNamespace,
      input.sessionsPath,
    );
    if (backendMetadata.logPath && !existsSync(backendMetadata.logPath))
      appendLog(backendMetadata.logPath, '');
    yield* input.repository.updateBackendMetadata({
      ptyProcessId: input.metadata.ptyProcessId,
      backend: input.backend.name,
      backendRefJson: JSON.stringify(backendMetadata.ref),
      logMode: backendMetadata.logMode,
      logPath: backendMetadata.logPath,
    });
    const startResult = yield* input.backend.launch({
      ptyProcessId: input.metadata.ptyProcessId,
      backendSessionName: backendMetadata.backendSessionName,
      command: input.metadata.command,
      args: input.metadata.args,
      cwd: input.metadata.cwd,
      env: input.env,
      shellIntegration: input.shellIntegration,
      onForegroundCommand: (event) =>
        void Effect.runPromise(
          recordForegroundCommandState(
            input.foreground,
            input.eventBus,
            event.ptyProcessId,
            event.state,
          ),
        ),
      cols: defaultCols,
      rows: defaultRows,
      logPath: backendMetadata.logPath,
      onExit: (exit) =>
        void Effect.runPromise(
          input.foreground
            .clear(input.metadata.ptyProcessId)
            .pipe(
              Effect.zipRight(
                handleExit(
                  input.repository,
                  input.eventBus,
                  input.activeAttachments,
                  input.terminations,
                  input.metadata.ptyProcessId,
                  exit,
                ),
              ),
            ),
        ),
    });
    return refWithShellIntegrationToken(startResult, input.shellIntegration);
  });
}

function recordForegroundCommandState(
  foreground: PtyForegroundStateService,
  eventBus: InternalRuntimeEventBusService,
  ptyProcessId: number,
  state: PtyForegroundCommandState,
) {
  return foreground.set(ptyProcessId, state).pipe(
    Effect.flatMap((changed) =>
      changed
        ? eventBus.publish({
            type:
              state === 'working'
                ? 'pty_foreground_command_started'
                : 'pty_foreground_command_ended',
            ptyProcessId,
          })
        : Effect.void,
    ),
  );
}

function handleAttachFailure(
  repository: PtyRepositoryService,
  backend: PtyBackendShape,
  eventBus: InternalRuntimeEventBusService,
  session: PtyProcessRecord,
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
  session: PtyProcessRecord,
  next: {
    readonly status: PtyProcessRecord['status'];
    readonly statusReason: PtyProcessRecord['statusReason'];
  },
  lastSeenAt?: string,
) {
  if (
    session.status === next.status &&
    session.statusReason === next.statusReason &&
    lastSeenAt === undefined
  )
    return Effect.void;
  return transitionProcessAndPublish(repository, eventBus, session, {
    ptyProcessId: session.id,
    status: next.status,
    statusReason: next.statusReason,
    exitCode: next.status === 'running' ? null : session.exitCode,
    signal: next.status === 'running' ? null : session.signal,
    ...(lastSeenAt !== undefined ? { lastSeenAt } : {}),
  });
}
