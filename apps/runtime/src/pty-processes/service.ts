import { mkdirSync } from 'node:fs';

import {
  Context,
  Duration,
  Effect,
  Exit,
  FiberMap,
  Layer,
  Queue,
  Result,
  Scope,
  Stream,
} from 'effect';

import type { PtyStreamOutputMessageSet } from '@isagi/contracts';

import { CliAccess } from '../cli-access/index.js';
import { describeOperationalCause } from '../platform/diagnostics/index.js';
import { InternalEvents } from '../platform/events/index.js';
import { runPeriodically } from '../platform/fibers/index.js';
import { DataDirectory, DatabaseError } from '../platform/persistence/index.js';
import { launchEnv, UserShell } from '../platform/process/index.js';
import { PtyBackendCatalog } from './backend.js';
import { PtyForegroundState } from './foreground-state.js';
import { PtyRepository } from './repository.js';
import { requireActiveAttachment, type ActiveAttachment } from './service/attachments.js';
import { decodeBackendRef } from './service/backend-ref.js';
import {
  cleanupPtyProcess,
  type PtyCleanupDependencies,
  type PtyProcessCleanupError,
  type PtyProcessCleanupOutcome,
} from './service/cleanup.js';
import { recordForegroundCommandState, transitionProcessAndPublish } from './service/events.js';
import { collectPtyGarbage } from './service/gc.js';
import { allocateLaunch, type PtyLaunchDependencies } from './service/launch.js';
import {
  isExitPending,
  isRowReserved,
  skipReservedRow,
  type DurablePtyTerminationReason,
  type PtyReservations,
  type PtySupervisors,
} from './service/lifecycle.js';
import {
  readPtyLogTail,
  replayBytesForProcess,
  replayProcessLog,
  reportOrphanPtyLogs,
  type PtyLogTail,
} from './service/logs.js';
import { makePersistenceRetry } from './service/retry.js';
import { runtimeNamespace } from './service/runtime-namespace.js';
import {
  terminatePtyProcess,
  terminatePtyProcesses,
  type PtyTerminateOutcome,
} from './service/termination.js';
import { PtyProcessSettings } from './settings.js';
import type { PtyProcessRecord, PtyProcessRow, PtyTeardownError } from './types.js';
import {
  PtyKillError,
  PtyResizeError,
  PtyServiceError,
  PtyTerminationInProgressError,
  PtyWriteError,
  type BackendSessionRef,
  type LaunchPtyProcessInput,
  type PtyBackend as PtyBackendShape,
  type PtyForegroundCommandState,
  type PtyOutputMessage,
  type PtyProcessAllocation,
  type PtyProcessLaunchMetadata,
} from './types.js';

const defaultCols = 100;
const defaultRows = 30;

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
export type PtyCleanupProcessError = PtyProcessCleanupError;
export type PtyAttachmentMode = 'interactive' | 'read_only';

/**
 * A websocket's hold on a process. It lasts as long as the scope `attach` ran in; `detach` ends it earlier (a
 * displaced attachment, a termination), and is idempotent.
 */
export interface PtyAttachment {
  readonly session: PtyProcessRecord;
  readonly attachmentId: symbol | null;
  readonly replayBytes: number | null;
  readonly live: boolean;
  readonly detach: Effect.Effect<void, never>;
}

export interface PtyAttachmentPlan {
  readonly session: PtyProcessRecord;
  readonly replayBytes: number | null;
  readonly live: boolean;
  readonly replaySource: 'backend' | 'file_log';
}

const make = Effect.gen(function* () {
  const repository = yield* PtyRepository;
  const catalog = yield* PtyBackendCatalog;
  const foreground = yield* PtyForegroundState;
  const directory = yield* DataDirectory;
  const eventBus = yield* InternalEvents;
  const userShell = yield* UserShell;
  const cliAccess = yield* CliAccess;
  const settings = yield* PtyProcessSettings;
  const userProcessEnvironment = launchEnv(userShell.environment.values);
  const activeAttachments = new Map<number, ActiveAttachment>();
  const pendingAttachments = new Set<number>();
  const pinnedPtyProcessIds = new Set<number>();
  // Two windows, one bundle: a termination attempt and a pending launch can
  // legitimately hold the same row at once during cancellation cleanup.
  const reservations: PtyReservations = { terminations: new Map(), launches: new Map() };
  const namespace = runtimeNamespace(directory.paths.root);

  // Acquisition order is the reverse of release order:
  //   retry (drained last, while the repository is still open) -> supervisors -> shutdown sweep -> periodic loops
  //   (stopped first).
  const retry = yield* makePersistenceRetry;
  const supervisors: PtySupervisors = yield* FiberMap.make<number, void, never>();

  mkdirSync(directory.paths.sessionsPath, { recursive: true });
  yield* reportOrphanPtyLogs(repository, directory.paths.sessionsPath);
  yield* reconcilePersistedProcesses(repository, catalog, eventBus, reservations, supervisors, {
    startup: true,
  });
  const collectGarbage = collectPtyGarbage(
    repository,
    catalog,
    namespace,
    directory.paths.sessionsPath,
    { pinnedPtyProcessIds, pendingLaunches: reservations.launches },
  );
  yield* collectGarbage;

  // The cleanup flow needs the same process-truth capabilities termination
  // does; bundling them keeps the call site from re-listing six fields.
  const cleanupDependencies: PtyCleanupDependencies = {
    repository,
    catalog,
    eventBus,
    activeAttachments,
    terminations: reservations.terminations,
    supervisors,
    retry,
  };

  const launchDependencies: PtyLaunchDependencies = {
    repository,
    catalog,
    eventBus,
    foreground,
    retry,
    supervisors,
    reservations,
    activeAttachments,
    runtimeNamespace: namespace,
    sessionsPath: directory.paths.sessionsPath,
    userProcessEnvironment,
    cliAccess,
  };

  const terminateWithReason = (
    ptyProcessId: number,
    reason: DurablePtyTerminationReason,
    gracefulTimeoutMs?: number,
  ) =>
    terminatePtyProcess({
      repository,
      catalog,
      eventBus,
      activeAttachments,
      terminations: reservations.terminations,
      retry,
      ptyProcessId,
      reason,
      gracefulTimeoutMs,
    });

  // Runs while the supervisors still consume exits, before they are interrupted: detach every websocket, then end
  // every live node-pty incarnation as a `runtime_shutdown`. Best effort per row: an already-dead incarnation is an
  // `already_absent` that commits nothing false, and a genuine control failure leaves the row running for the next
  // startup reconciliation to classify honestly. Deferred writes the sweep hands to `retry` are drained after it.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const sessions = yield* repository
        .listProcesses({ statuses: ['starting', 'running'] })
        .pipe(Effect.orElseSucceed(() => []));
      for (const active of [...activeAttachments.values()]) yield* active.release;
      activeAttachments.clear();
      for (const session of sessions) {
        if (session.backend !== 'node_pty') continue;
        yield* terminateWithReason(session.id, 'runtime_shutdown').pipe(
          Effect.catch((error) =>
            Effect.logWarning('Could not terminate PTY process at shutdown').pipe(
              Effect.annotateLogs({
                ptyProcessId: session.id,
                cause: describeOperationalCause(error),
              }),
            ),
          ),
        );
      }
    }),
  );

  yield* runPeriodically(
    'PTY status polling',
    settings.statusPollInterval,
    reconcilePersistedProcesses(repository, catalog, eventBus, reservations, supervisors, {
      startup: false,
    }),
  );
  yield* runPeriodically('PTY GC', settings.garbageCollectionInterval, collectGarbage);

  const terminate: PtyService['Service']['terminate'] = Effect.fn('PtyService.terminate')(
    function* (input) {
      return yield* terminateWithReason(
        input.ptyProcessId,
        'user_requested',
        input.gracefulTimeoutMs,
      );
    },
  );

  return PtyService.of({
    launch: Effect.fn('PtyService.launch')(function* (input) {
      yield* Effect.logInfo('PTY process launch starting').pipe(
        Effect.annotateLogs({ command: input.command, cwd: input.cwd }),
      );
      // The scoped releaser covers the never-started case — including an
      // interruption landing between acquisition and `start` — and is a
      // no-op once `start` has begun.
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const allocation = yield* Effect.acquireRelease(
            allocateLaunch(launchDependencies, input),
            (acquired) => acquired.abandon,
          );
          return yield* allocation.start;
        }),
      );
    }),
    allocateLaunch: Effect.fn('PtyService.allocateLaunch')(function* (input) {
      return yield* allocateLaunch(launchDependencies, input);
    }),
    getAttachmentPlan: Effect.fn('PtyService.getAttachmentPlan')(function* (input) {
      return yield* getAttachmentPlan(repository, catalog, input.ptyProcessId);
    }),
    attach: Effect.fn('PtyService.attach')(function* (input) {
      return yield* attachToProcess(
        repository,
        catalog,
        eventBus,
        foreground,
        activeAttachments,
        pendingAttachments,
        reservations,
        supervisors,
        input,
      );
    }),
    replay: Effect.fn('PtyService.replay')(function* (input) {
      return yield* replayProcess(catalog, input);
    }),
    write: Effect.fn('PtyService.write')(function* (input) {
      const active = yield* requireActiveAttachment(
        activeAttachments,
        input.ptyProcessId,
        input.attachmentId,
      );
      yield* active.attachment.write(input.data);
    }),
    writeInput: Effect.fn('PtyService.writeInput')(function* (input) {
      const plan = yield* getAttachmentPlan(repository, catalog, input.ptyProcessId);
      if (!plan.live) {
        return yield* new PtyServiceError({
          code: 'session_not_running',
          message: `PTY process ${input.ptyProcessId} is not running.`,
          ptyProcessId: input.ptyProcessId,
        });
      }
      const ref = yield* decodeBackendRef(plan.session);
      // `getAttachmentPlan` already probed this row's adapter; re-checking
      // availability here would only buy a second `tmux -V`.
      const backend = yield* catalog.forBackend(plan.session.backend);
      yield* backend.writeInput({ ref, data: input.data });
    }),
    resize: Effect.fn('PtyService.resize')(function* (input) {
      const active = yield* requireActiveAttachment(
        activeAttachments,
        input.ptyProcessId,
        input.attachmentId,
      );
      yield* active.attachment.resize({ cols: input.cols, rows: input.rows });
    }),
    kill: Effect.fn('PtyService.kill')(function* (input) {
      return yield* terminateWithReason(input.ptyProcessId, 'user_requested');
    }),
    terminate,
    terminateMany: Effect.fn('PtyService.terminateMany')(function* (input) {
      return yield* terminatePtyProcesses(terminate, input);
    }),
    findProcess: Effect.fn('PtyService.findProcess')(function* (ptyProcessId) {
      return yield* repository.findProcess(ptyProcessId);
    }),
    cleanupProcess: Effect.fn('PtyService.cleanupProcess')(function* (input) {
      return yield* cleanupPtyProcess(cleanupDependencies, input);
    }),
    pin: Effect.fn('PtyService.pin')((input) =>
      Effect.sync(() => {
        pinnedPtyProcessIds.add(input.ptyProcessId);
      }),
    ),
    unpin: Effect.fn('PtyService.unpin')((input) =>
      Effect.sync(() => {
        pinnedPtyProcessIds.delete(input.ptyProcessId);
      }),
    ),
    isPinned: Effect.fn('PtyService.isPinned')((input) =>
      Effect.sync(() => pinnedPtyProcessIds.has(input.ptyProcessId)),
    ),
    readLogTail: Effect.fn('PtyService.readLogTail')(function* (input) {
      // A caller-side bug, not an operational failure: the only caller
      // passes a fixed constant. Clamping would hide it, and a tagged
      // member would widen this channel for a case that cannot occur.
      if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0) {
        return yield* Effect.die(new RangeError('maxBytes must be a non-negative safe integer'));
      }
      const session = yield* repository.findProcess(input.ptyProcessId);
      // A process that never existed is not a process that retained nothing.
      if (!session) {
        return yield* new PtyServiceError({
          code: 'session_not_found',
          message: `PTY process ${input.ptyProcessId} was not found.`,
          ptyProcessId: input.ptyProcessId,
        });
      }
      return yield* readPtyLogTail({
        logPath: session.logPath,
        logMode: session.logMode,
        maxBytes: input.maxBytes,
      });
    }),
  });
});

interface PtyServiceShape {
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
  /**
   * Attaches to a live process for as long as the caller's scope stays open: its output and exit go to `send`, in
   * order, until that scope closes or the attachment's `detach` runs. A process that is not live yields a non-live
   * attachment.
   */
  readonly attach: (input: {
    readonly ptyProcessId: number;
    readonly mode: PtyAttachmentMode;
    readonly supersede?: boolean | undefined;
    readonly displace?:
      | ((attachment: PtyAttachment) => Effect.Effect<void, never> | undefined)
      | undefined;
    readonly send: (message: PtyStreamOutputMessageSet) => void;
  }) => Effect.Effect<PtyAttachment, PtyAttachError, Scope.Scope>;
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
  /**
   * Terminates several processes concurrently for an owner tearing down its durable entities.
   * Each failure is logged; `required` then fails with `PtyTeardownError` naming every process it
   * could not stop, `best_effort` succeeds.
   */
  readonly terminateMany: (input: {
    readonly failurePolicy: 'best_effort' | 'required';
    readonly gracefulTimeoutMs: number;
    readonly operation: string;
    readonly ptyProcessIds: readonly number[];
  }) => Effect.Effect<void, PtyTeardownError>;
  /** One process row, or `null` when it does not exist. */
  readonly findProcess: (
    ptyProcessId: number,
  ) => Effect.Effect<PtyProcessRow | null, DatabaseError>;

  // Verify-or-terminate one incarnation for a caller that owns durable cleanup:
  // boot convergence and the worktree-deletion audit. Unlike `terminate` it
  // tolerates an already-finished row, and unlike the poller it never guesses —
  // anything it could not establish fails.
  readonly cleanupProcess: (input: {
    readonly ptyProcessId: number;
    readonly reason: DurablePtyTerminationReason;
    readonly gracefulTimeoutMs?: number | undefined;
    readonly ensureBackendAbsence?: boolean | undefined;
  }) => Effect.Effect<PtyProcessCleanupOutcome, PtyCleanupProcessError>;
  readonly pin: (input: { readonly ptyProcessId: number }) => Effect.Effect<void>;
  readonly unpin: (input: { readonly ptyProcessId: number }) => Effect.Effect<void>;
  readonly isPinned: (input: { readonly ptyProcessId: number }) => Effect.Effect<boolean>;
  /**
   * The last `maxBytes` of one incarnation's retained log, read on demand.
   *
   * Bounded by the caller because the bound is a product decision, not this
   * layer's. A row that retains nothing answers `{ excerpt: null }` rather than
   * failing — "nothing was retained" and "we could not read it" are different
   * facts, and only the second is worth a retry.
   */
  readonly readLogTail: (input: {
    readonly ptyProcessId: number;
    readonly maxBytes: number;
  }) => Effect.Effect<PtyLogTail, DatabaseError | PtyServiceError>;
}

export class PtyService extends Context.Service<PtyService, PtyServiceShape>()(
  'isagi/runtime/pty-processes/PtyService',
) {
  static readonly layerNoDeps = Layer.effect(PtyService, make);
  static readonly layer = PtyService.layerNoDeps.pipe(
    Layer.provide([
      CliAccess.layer,
      InternalEvents.layer,
      PtyBackendCatalog.layer,
      PtyForegroundState.layer,
      PtyRepository.layer,
    ]),
  );
}

function attachToProcess(
  repository: PtyRepository['Service'],
  catalog: PtyBackendCatalog['Service'],
  eventBus: InternalEvents['Service'],
  foreground: PtyForegroundState['Service'],
  activeAttachments: Map<number, ActiveAttachment>,
  pendingAttachments: Set<number>,
  reservations: PtyReservations,
  supervisors: PtySupervisors,
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
      } satisfies PtyAttachment;
    const session = plan.session;
    const ref = yield* decodeBackendRef(session);
    // The plan already probed this row's adapter for availability.
    const backend = yield* catalog.forBackend(session.backend);
    if (activeAttachments.has(session.id) || pendingAttachments.has(session.id)) {
      const active = activeAttachments.get(session.id);
      if (input.supersede && active && !pendingAttachments.has(session.id)) {
        if (!active.displace) {
          return yield* alreadyAttached(session.id);
        }
        yield* active.displace;
      } else {
        return yield* alreadyAttached(session.id);
      }
    }
    if (activeAttachments.has(session.id) || pendingAttachments.has(session.id)) {
      return yield* alreadyAttached(session.id);
    }
    pendingAttachments.add(session.id);
    return yield* Effect.gen(function* () {
      // The attachment's own scope, a child of the caller's: the caller's scope closing releases it, and `detach`
      // (displacement, termination, shutdown) releases it earlier.
      const attachScope = yield* Scope.fork(yield* Effect.scope);
      const release = Scope.close(attachScope, Exit.void);
      const output = yield* Queue.unbounded<PtyOutputMessage>();
      const foregroundChanges = yield* Queue.unbounded<PtyForegroundCommandState>();
      const attachResult = yield* backend
        .attach({
          ref,
          cols: defaultCols,
          rows: defaultRows,
          output,
          foreground: foregroundChanges,
        })
        .pipe(Scope.provide(attachScope), Effect.result);
      if (Result.isFailure(attachResult)) {
        yield* release;
        yield* handleAttachFailure(
          repository,
          backend,
          eventBus,
          reservations,
          supervisors,
          session,
          ref,
        );
        return yield* new PtyServiceError({
          code: 'backend_attach_failed',
          message: `Could not attach to PTY process ${session.id}.`,
          ptyProcessId: session.id,
          cause: attachResult.failure,
        });
      }
      // Output reaches `send` in the order the backend produced it, starting with anything that arrived while the
      // attachment was being set up. Both forwarders stop when the attachment scope closes.
      yield* Stream.fromQueue(output).pipe(
        Stream.runForEach((message) => Effect.sync(() => input.send(message))),
        Effect.forkIn(attachScope),
      );
      yield* Stream.fromQueue(foregroundChanges).pipe(
        Stream.runForEach((state) =>
          recordForegroundCommandState(foreground, eventBus, session.id, state),
        ),
        Effect.forkIn(attachScope),
      );
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
      const ptyAttachment = {
        session,
        attachmentId: input.mode === 'interactive' ? attachmentId : null,
        replayBytes: attachResult.success.replayBytes,
        live: true,
        detach: release,
      } satisfies PtyAttachment;
      activeAttachments.set(session.id, {
        ptyProcessId: session.id,
        attachmentId,
        attachment: attachResult.success,
        release,
        displace: input.displace?.(ptyAttachment),
      });
      // Registered last, so it runs first when the attachment scope closes: the entry stops routing writes before the
      // backend detaches.
      yield* Scope.addFinalizer(
        attachScope,
        Effect.suspend(() => {
          if (activeAttachments.get(session.id)?.attachmentId !== attachmentId) return Effect.void;
          activeAttachments.delete(session.id);
          return Effect.logInfo('PTY websocket detach').pipe(
            Effect.annotateLogs({ ptyProcessId: session.id }),
          );
        }),
      );
      return ptyAttachment;
    }).pipe(Effect.ensuring(Effect.sync(() => pendingAttachments.delete(session.id))));
  });
}

function alreadyAttached(ptyProcessId: number) {
  return Effect.fail(
    new PtyServiceError({
      code: 'session_already_attached',
      message: `PTY process ${ptyProcessId} already has an active websocket attachment.`,
      ptyProcessId,
    }),
  );
}

function replayProcess(
  catalog: PtyBackendCatalog['Service'],
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
    const backend = yield* catalog.forBackend(input.session.backend);
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
  repository: PtyRepository['Service'],
  catalog: PtyBackendCatalog['Service'],
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
    if (live && !(yield* (yield* catalog.forBackend(session.backend)).available))
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

// Exported as a test seam. The reservation skip below is otherwise only
// reachable on the ten-second poll timer, and a race that important should be
// proven by injecting a pass, not by racing a clock.
export function reconcilePersistedProcesses(
  repository: PtyRepository['Service'],
  catalog: PtyBackendCatalog['Service'],
  eventBus: InternalEvents['Service'],
  reservations: PtyReservations,
  supervisors: PtySupervisors,
  options: { readonly startup: boolean },
) {
  return Effect.gen(function* () {
    // A reservation older than one poll interval is reported, once.
    const warnAfterMs = Duration.toMillis((yield* PtyProcessSettings).statusPollInterval);
    const sessions = yield* repository.listProcesses({ statuses: ['starting', 'running'] });
    for (const session of sessions) {
      // A committed termination attempt or an in-flight launch owns this row's
      // outcome. Inspecting now could assign `backend_process_missing` to a
      // process one demonstrably killed or is still starting, and immutability
      // would make that misattribution permanent.
      if (yield* skipReservedRow(reservations, session.id, warnAfterMs)) continue;
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
      const backend = yield* catalog.forBackend(session.backend);
      const inspection = yield* backend
        .inspect(ref)
        .pipe(Effect.catch((cause) => Effect.succeed({ status: 'unavailable' as const, cause })));
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
          // An exit the backend reported but the supervisor has not persisted yet; its real code wins.
          if (isExitPending(supervisors, session.id)) break;
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
  repository: PtyRepository['Service'],
  backend: PtyBackendShape,
  eventBus: InternalEvents['Service'],
  reservations: PtyReservations,
  supervisors: PtySupervisors,
  session: PtyProcessRecord,
  ref: BackendSessionRef,
) {
  return Effect.gen(function* () {
    // Silently defer to the reserving attempt or launch. Unlike the poller this
    // has no fixed cadence to bound a warning against, so logging here would
    // make diagnostics depend on how often a user tries to attach.
    if (isRowReserved(reservations, session.id)) return;
    // Equally defer to a supervisor that may hold an exit the backend reported but has not persisted yet: a node-pty
    // attach fails with "not live" in exactly that window, and the supervisor is about to write the real exit code.
    if (isExitPending(supervisors, session.id)) return;
    if (session.backend === 'node_pty') {
      yield* transitionIfChanged(repository, eventBus, session, {
        status: 'failed',
        statusReason: 'runtime_ephemeral_lost',
      });
      return;
    }
    const inspection = yield* backend
      .inspect(ref)
      .pipe(Effect.catch((cause) => Effect.succeed({ status: 'unavailable' as const, cause })));
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
  repository: PtyRepository['Service'],
  eventBus: InternalEvents['Service'],
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
