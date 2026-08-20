import { mkdirSync } from 'node:fs';

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
import { PtyRepository, type PtyRepositoryService } from './pty.repository.js';
import {
  detachActiveAttachment,
  requireActiveAttachment,
  type ActiveAttachment,
} from './service/attachments.js';
import { decodeBackendRef } from './service/backend-ref.js';
import { recordForegroundCommandState, transitionProcessAndPublish } from './service/events.js';
import { collectPtyGarbage, startPtyGarbageCollector } from './service/gc.js';
import { allocateLaunch, type PtyLaunchDependencies } from './service/launch.js';
import { isRowReserved, skipReservedRow, type PtyReservations } from './service/lifecycle.js';
import { replayBytesForProcess, replayProcessLog, reportOrphanPtyLogs } from './service/logs.js';
import { makePtyRetryScheduler } from './service/retry.js';
import { launchEnv, runtimeNamespace } from './service/runtime-namespace.js';
import { terminatePtyProcess, type PtyTerminateOutcome } from './service/termination.js';
import {
  PtyKillError,
  PtyResizeError,
  PtyServiceError,
  PtyTerminationInProgressError,
  PtyWriteError,
  type BackendSessionRef,
  type LaunchPtyProcessInput,
  type PtyBackend as PtyBackendShape,
  type PtyProcessAllocation,
  type PtyProcessLaunchMetadata,
} from './types.js';

const defaultCols = 100;
const defaultRows = 30;
const statusPollIntervalMs = 10_000;

// Allocation is the only fallible public stage of a launch: `start` has an
// empty expected-error channel and the composed `launch` inherits allocation's.
export type PtyLaunchError = DatabaseError;
export type PtyAttachError = DatabaseError | PtyServiceError;
export type PtyInputError = DatabaseError | PtyServiceError | PtyWriteError | PtyResizeError;
export type PtyKillProcessError =
  | DatabaseError
  | PtyServiceError
  | PtyKillError
  | PtyTerminationInProgressError;
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
  // Durable PTY metadata before any process exists, so a caller can persist
  // ownership pre-spawn. Acquire it with
  // `Effect.acquireRelease(allocateLaunch(input), a => a.abandon)`; `launch` is
  // exactly this followed by `start`.
  readonly allocateLaunch: (
    input: LaunchPtyProcessInput,
  ) => Effect.Effect<PtyProcessAllocation, PtyLaunchError>;
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
  // Resolves to what the attempt actually did, so a caller that owns a stop
  // cause can bind it only to an affirmative kill.
  readonly kill: (input: {
    readonly ptyProcessId: number;
  }) => Effect.Effect<PtyTerminateOutcome, PtyKillProcessError>;
  readonly terminate: (input: {
    readonly ptyProcessId: number;
    readonly gracefulTimeoutMs: number;
  }) => Effect.Effect<PtyTerminateOutcome, PtyKillProcessError>;
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
    // Two windows, one bundle: a termination attempt and a pending launch can
    // legitimately hold the same row at once during cancellation cleanup.
    const reservations: PtyReservations = { terminations: new Map(), launches: new Map() };
    // Deferred terminal writes belong to this scope: they are scheduled here and
    // drained in the finalizer below, while the repository is still open.
    const retry = makePtyRetryScheduler();
    const namespace = runtimeNamespace(directory.paths.root);

    mkdirSync(directory.paths.sessionsPath, { recursive: true });
    yield* reportOrphanPtyLogs(repository, directory.paths.sessionsPath);
    yield* reconcilePersistedProcesses(repository, catalog, eventBus, reservations, {
      startup: true,
    });
    yield* collectPtyGarbage(repository, catalog, namespace, directory.paths.sessionsPath, {
      pinnedPtyProcessIds,
      pendingLaunches: reservations.launches,
    });
    const pollTimer = startStatusPolling(repository, catalog, eventBus, reservations);
    const gcTimer = startPtyGarbageCollector(
      repository,
      catalog,
      namespace,
      directory.paths.sessionsPath,
      { pinnedPtyProcessIds, pendingLaunches: reservations.launches },
    );

    const launchDependencies: PtyLaunchDependencies = {
      repository,
      catalog,
      eventBus,
      foreground,
      retry,
      reservations,
      activeAttachments,
      runtimeNamespace: namespace,
      sessionsPath: directory.paths.sessionsPath,
      userProcessEnvironment,
    };

    const service = {
      launch: (input) =>
        Effect.scoped(
          Effect.gen(function* () {
            console.info(
              `[runtime] PTY process launch starting command=${input.command} cwd=${input.cwd}`,
            );
            // The scoped releaser covers the never-started case — including an
            // interruption landing between acquisition and `start` — and is a
            // no-op once `start` has begun.
            const allocation = yield* Effect.acquireRelease(
              allocateLaunch(launchDependencies, input),
              (acquired) => acquired.abandon,
            );
            return yield* allocation.start;
          }),
        ),
      allocateLaunch: (input) => allocateLaunch(launchDependencies, input),
      getAttachmentPlan: (input) => getAttachmentPlan(repository, catalog, input.ptyProcessId),
      attach: (input) =>
        attachToProcess(
          repository,
          catalog,
          eventBus,
          foreground,
          activeAttachments,
          pendingAttachments,
          reservations,
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
        terminatePtyProcess({
          repository,
          catalog,
          eventBus,
          activeAttachments,
          terminations: reservations.terminations,
          retry,
          ptyProcessId: input.ptyProcessId,
          reason: 'user_requested',
        }),
      terminate: (input) =>
        terminatePtyProcess({
          repository,
          catalog,
          eventBus,
          activeAttachments,
          terminations: reservations.terminations,
          retry,
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
          // Best effort: an already-dead incarnation is an `already_absent` that
          // commits nothing false, and a genuine control failure leaves the row
          // running for the next startup reconciliation to classify honestly.
          yield* terminatePtyProcess({
            repository,
            catalog,
            eventBus,
            activeAttachments,
            terminations: reservations.terminations,
            retry,
            ptyProcessId: session.id,
            reason: 'runtime_shutdown',
          }).pipe(Effect.ignore);
        }
        // Last: the sweep above can hand work to the scheduler, and draining it
        // here is what keeps a deferred terminal write out of a closed database.
        yield* retry.shutdown;
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
  reservations: PtyReservations,
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
        yield* handleAttachFailure(repository, backend, eventBus, reservations, session, ref);
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
  reservations: PtyReservations,
) {
  const timer = setInterval(() => {
    void Effect.runPromise(
      reconcilePersistedProcesses(repository, catalog, eventBus, reservations, {
        startup: false,
      }).pipe(
        Effect.catchAll((error) =>
          Effect.sync(() => console.warn('[runtime] PTY status polling failed', error)),
        ),
      ),
    );
  }, statusPollIntervalMs);
  timer.unref();
  return timer;
}

// Exported as a test seam. The reservation skip below is otherwise only
// reachable on the ten-second poll timer, and a race that important should be
// proven by injecting a pass, not by racing a clock.
export function reconcilePersistedProcesses(
  repository: PtyRepositoryService,
  catalog: PtyBackendCatalogService,
  eventBus: InternalRuntimeEventBusService,
  reservations: PtyReservations,
  options: { readonly startup: boolean },
) {
  return Effect.gen(function* () {
    const sessions = yield* repository.listProcesses({ statuses: ['starting', 'running'] });
    for (const session of sessions) {
      // A committed termination attempt or an in-flight launch owns this row's
      // outcome. Inspecting now could assign `backend_process_missing` to a
      // process one demonstrably killed or is still starting, and immutability
      // would make that misattribution permanent.
      if (skipReservedRow(reservations, session.id, statusPollIntervalMs)) continue;
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

function handleAttachFailure(
  repository: PtyRepositoryService,
  backend: PtyBackendShape,
  eventBus: InternalRuntimeEventBusService,
  reservations: PtyReservations,
  session: PtyProcessRecord,
  ref: BackendSessionRef,
) {
  return Effect.gen(function* () {
    // Silently defer to the reserving attempt or launch. Unlike the poller this
    // has no fixed cadence to bound a warning against, so logging here would
    // make diagnostics depend on how often a user tries to attach.
    if (isRowReserved(reservations, session.id)) return;
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
