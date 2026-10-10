import { existsSync } from 'node:fs';

import { Effect, FiberMap, Result, Stream } from 'effect';

import type { CliAccess } from '../../cli-access/index.js';
import { describeOperationalCause } from '../../platform/diagnostics/index.js';
import type { InternalEvents } from '../../platform/events/index.js';
import type { DatabaseError } from '../../platform/persistence/index.js';
import { shellLaunchCommand } from '../../platform/process/index.js';
import type { PtyBackendCatalog } from '../backend.js';
import type { PtyForegroundState } from '../foreground-state.js';
import { appendLog, type PtyRepository } from '../repository.js';
import {
  PtyLogError,
  type LaunchedBackendSession,
  type LaunchPtyProcessInput,
  type PtyBackend as PtyBackendShape,
  type PtyProcessAllocation,
  type PtyProcessEvent,
  type PtyProcessLaunchMetadata,
  type PtyStartError,
} from '../types.js';
import type { ActiveAttachment } from './attachments.js';
import { backendMetadataForLaunch } from './backend-ref.js';
import { recordForegroundCommandState, transitionProcessByIdAndPublish } from './events.js';
import {
  handleExit,
  releaseLaunch,
  reserveLaunch,
  type PtyPendingExits,
  type PtyReservations,
} from './lifecycle.js';
import type { PtyPersistenceRetry } from './retry.js';
import { spawnFailureMessage } from './runtime-namespace.js';
import { prepareShellIntegration, refWithShellIntegrationToken } from './shell-integration.js';
import type { ShellIntegrationConfig } from './shell-integration.js';
import { terminatePtyProcess } from './termination.js';

const defaultCols = 100;
const defaultRows = 30;

export interface PtyLaunchDependencies {
  readonly repository: PtyRepository['Service'];
  readonly catalog: PtyBackendCatalog['Service'];
  readonly eventBus: InternalEvents['Service'];
  readonly foreground: PtyForegroundState['Service'];
  readonly retry: PtyPersistenceRetry;
  /**
   * `supervisors` holds one supervisor fiber per launched process, consuming its backend `events`. Owned by the PTY
   * service scope, so a supervisor outlives the request that launched the process and is interrupted when the service
   * shuts down. A supervisor, or the deferred write it hands to `retry`, also tells observers that an exit may still
   * be in flight (`isExitPending`).
   */
  readonly pendingExits: PtyPendingExits;
  readonly reservations: PtyReservations;
  readonly activeAttachments: Map<number, ActiveAttachment>;
  readonly runtimeNamespace: string;
  readonly sessionsPath: string;
  readonly userProcessEnvironment: NodeJS.ProcessEnv;
  readonly cliAccess: CliAccess['Service'];
}

type PtyAllocationPhase = 'allocated' | 'starting' | 'settled' | 'abandoned';

/**
 * Create the durable PTY row and reserve it — and nothing else. No environment
 * is resolved, no backend metadata is written, and no process exists yet, so a
 * caller can persist its own ownership of `ptyProcessId` before anything can
 * possibly run under it.
 *
 * Callers should acquire this through
 * `Effect.acquireRelease(allocateLaunch(...), allocation => allocation.abandon)`
 * so the never-started case is always cleaned up. Ownership of the reservation
 * is explicit across both intervals: the closure-captured compensation below
 * owns it until acquisition succeeds — `acquireRelease` registers its releaser
 * only at that point — and the scoped releaser or `start`'s finalizer owns it
 * afterwards.
 */
export function allocateLaunch(
  deps: PtyLaunchDependencies,
  input: LaunchPtyProcessInput,
): Effect.Effect<PtyProcessAllocation, DatabaseError> {
  return Effect.suspend(() => {
    let reserved: number | null = null;
    return deps.repository
      .createProcessMetadata({
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        onInserted: (ptyProcessId) => {
          reserved = ptyProcessId;
          reserveLaunch(deps.reservations.launches, ptyProcessId);
        },
      })
      .pipe(
        // Covers a commit-level fault after the hook already ran. Nothing
        // fallible sits between here and success — building the allocation
        // object is pure — so no reservation can survive without an owner.
        Effect.tapError(() =>
          Effect.sync(() => {
            if (reserved !== null) releaseLaunch(deps.reservations.launches, reserved);
          }),
        ),
        Effect.map((ptyProcessId) => makeAllocation(deps, input, ptyProcessId)),
      );
  }).pipe(
    // A single synchronous SQLite write with no meaningful interruption point.
    // Making it uninterruptible here means the compensation above holds
    // regardless of how a caller acquires the allocation.
    Effect.uninterruptible,
  );
}

function makeAllocation(
  deps: PtyLaunchDependencies,
  input: LaunchPtyProcessInput,
  ptyProcessId: number,
): PtyProcessAllocation {
  let phase: PtyAllocationPhase = 'allocated';

  // Attached only once the phase has actually moved to `starting`, so a second
  // `start` cannot settle — or release the reservation of — the first one.
  const settle = Effect.sync(() => {
    phase = 'settled';
    releaseLaunch(deps.reservations.launches, ptyProcessId);
  });

  const start: Effect.Effect<PtyProcessLaunchMetadata> = Effect.suspend(() => {
    if (phase !== 'allocated') {
      return Effect.die(
        new Error(
          `PTY launch allocation ${ptyProcessId} cannot be started from phase ${phase}. An allocation starts at most once.`,
        ),
      );
    }
    phase = 'starting';
    return startAllocation(deps, input, ptyProcessId).pipe(Effect.ensuring(settle));
  });

  const abandon: Effect.Effect<void, never> = Effect.suspend(() => {
    if (phase !== 'allocated') return Effect.void;
    phase = 'abandoned';
    return markLaunchFailed(
      deps,
      ptyProcessId,
      'Could not mark abandoned PTY launch allocation',
    ).pipe(
      Effect.ensuring(Effect.sync(() => releaseLaunch(deps.reservations.launches, ptyProcessId))),
    );
  }).pipe(Effect.uninterruptible);

  return { ptyProcessId, start, abandon };
}

/**
 * Two interruptible regions — pre-spawn preparation and the backend spawn —
 * inside one uninterruptible mask. Everything else (phase mutation, terminal
 * writes, cancellation cleanup) is uninterruptible, and `start`'s `ensuring`
 * releases the reservation on every exit including interruption.
 *
 * Total for every uninterrupted path: expected pre-spawn (`DatabaseError`, `PtyLogError`) and
 * spawn (`PtyStartError`) failures fold into the row and metadata is still
 * returned, because the pre-launch metadata write already made the incarnation
 * inspectable and killable. Defects stay defects and are never dressed up as a
 * launch failure.
 */
function startAllocation(
  deps: PtyLaunchDependencies,
  input: LaunchPtyProcessInput,
  ptyProcessId: number,
): Effect.Effect<PtyProcessLaunchMetadata> {
  const metadata: PtyProcessLaunchMetadata = {
    ptyProcessId,
    command: input.command,
    args: input.args,
    cwd: input.cwd,
    logPath: null,
  };

  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const prepared = yield* restore(prepareLaunch(deps, input, ptyProcessId)).pipe(
        Effect.result,
        // Quiescence-safe: nothing has reached a backend yet, so no session can
        // ever materialize for this row and a terminal write is honest.
        Effect.onInterrupt(() =>
          markLaunchFailed(deps, ptyProcessId, 'Could not mark cancelled PTY launch'),
        ),
      );
      if (Result.isFailure(prepared)) {
        yield* Effect.logWarning('PTY process launch preparation failed').pipe(
          Effect.annotateLogs({
            ptyProcessId,
            command: metadata.command,
            cause: describeOperationalCause(prepared.failure),
          }),
        );
        yield* markLaunchFailed(deps, ptyProcessId, 'Could not mark failed PTY launch');
        return yield* withPersistedLogPath(deps, metadata);
      }

      const spawned = yield* restore(spawnBackendProcess(prepared.success, metadata)).pipe(
        Effect.result,
        Effect.onInterrupt(() => cleanupCancelledSpawn(deps, ptyProcessId)),
      );
      if (Result.isFailure(spawned)) {
        yield* foldSpawnFailure(deps, metadata, spawned.failure);
        return yield* withPersistedLogPath(deps, metadata);
      }

      // Uninterruptible since the spawn returned, so a live process always gets its supervisor. Events the process
      // produced before this point wait in its queue.
      yield* superviseProcess(deps, ptyProcessId, spawned.success.events);

      // Past this point nothing is load-bearing for ownership: the process is
      // durably inspectable and killable through the metadata written before the
      // spawn. A persistence failure here is logged and absorbed rather than
      // compensated with a kill, and the released reservation lets the status
      // poller heal a row still sitting at `starting`.
      yield* deps.repository
        .updateBackendRef({
          ptyProcessId,
          backendRefJson: JSON.stringify(spawned.success.ref),
        })
        .pipe(
          Effect.andThen(
            transitionProcessByIdAndPublish(deps.repository, deps.eventBus, {
              ptyProcessId,
              status: 'running',
              statusReason: null,
              exitCode: null,
              signal: null,
            }),
          ),
          Effect.catch((error) =>
            Effect.logWarning(
              'Could not persist PTY launch result; the process is live and the poller will reconcile it',
            ).pipe(Effect.annotateLogs({ ptyProcessId, cause: describeOperationalCause(error) })),
          ),
        );
      return yield* withPersistedLogPath(deps, metadata);
    }),
  );
}

function prepareLaunch(
  deps: PtyLaunchDependencies,
  input: LaunchPtyProcessInput,
  ptyProcessId: number,
): Effect.Effect<PreparedLaunch, DatabaseError | PtyLogError> {
  return Effect.gen(function* () {
    // `foreground.clear` and `envForProcess` have empty expected-error channels
    // by contract, so nothing they raise is folded into a launch failure.
    yield* deps.foreground.clear(ptyProcessId);
    // Resolved per launch: the runtime URL is only known once the server listens, while the user
    // environment was captured when the layer was built. Explicit overrides still win.
    const cliEnvironment = yield* deps.cliAccess.launchEnvironment(
      deps.userProcessEnvironment.PATH,
    );
    const processEnvironment: NodeJS.ProcessEnv = {
      ...deps.userProcessEnvironment,
      ...cliEnvironment,
      ...input.envOverrides,
      ...(input.envForProcess ? yield* input.envForProcess({ ptyProcessId }) : {}),
    };
    const backendCommand = shellLaunchCommand({ launch: input, env: processEnvironment });
    if (backendCommand.fallback) {
      yield* Effect.logWarning('User-shell PTY launch fell back to a direct command').pipe(
        Effect.annotateLogs({
          ptyProcessId,
          command: input.command,
          reason: backendCommand.fallback,
        }),
      );
    }
    const shell = prepareShellIntegration({
      launch: {
        ...input,
        command: backendCommand.command,
        args: backendCommand.args,
        launchMode: 'direct',
      },
      ptyProcessId,
      sessionsPath: deps.sessionsPath,
      env: processEnvironment,
    });
    // The only read of the launch preference in the whole flow: a new
    // incarnation is created by the configured adapter unless the caller named
    // one, while every operation on an existing one dispatches through its
    // persisted backend. An explicit selection resolves through the same
    // catalog, which already rejects an unknown name loudly.
    const backend = input.backend
      ? yield* deps.catalog.forBackend(input.backend)
      : deps.catalog.configured;
    const backendMetadata = backendMetadataForLaunch(
      backend,
      { ptyProcessId, logPath: null },
      deps.runtimeNamespace,
      deps.sessionsPath,
    );
    const logPath = backendMetadata.logPath;
    if (logPath && !existsSync(logPath)) {
      // A log that cannot be created is an expected launch failure (full disk, refused permission, a removed sessions
      // directory): it folds into the row like any other pre-spawn failure instead of dying as a defect.
      yield* Effect.try({
        try: () => appendLog(logPath, ''),
        catch: (cause) => new PtyLogError({ operation: 'create', ptyProcessId, cause }),
      });
    }
    // This is the write that makes the incarnation inspectable and killable,
    // which is why it precedes the spawn and why nothing after the spawn needs
    // to be compensated.
    yield* deps.repository.updateBackendMetadata({
      ptyProcessId,
      backend: backend.name,
      backendRefJson: JSON.stringify(backendMetadata.ref),
      logMode: backendMetadata.logMode,
      logPath: backendMetadata.logPath,
    });
    return {
      backend,
      backendSessionName: backendMetadata.backendSessionName,
      logPath: backendMetadata.logPath,
      command: shell.command,
      args: shell.args,
      env: shell.env,
      shellIntegration: shell.shellIntegration,
    } satisfies PreparedLaunch;
  });
}

interface PreparedLaunch {
  readonly backend: PtyBackendShape;
  readonly backendSessionName: string | null;
  readonly logPath: string | null;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly shellIntegration: ShellIntegrationConfig | null;
}

function spawnBackendProcess(
  prepared: PreparedLaunch,
  metadata: PtyProcessLaunchMetadata,
): Effect.Effect<LaunchedBackendSession, PtyStartError> {
  return prepared.backend
    .launch({
      ptyProcessId: metadata.ptyProcessId,
      backendSessionName: prepared.backendSessionName,
      command: prepared.command,
      args: prepared.args,
      cwd: metadata.cwd,
      env: prepared.env,
      shellIntegration: prepared.shellIntegration,
      cols: defaultCols,
      rows: defaultRows,
      logPath: prepared.logPath,
    })
    .pipe(
      Effect.map((launched) => ({
        ref: refWithShellIntegrationToken(launched.ref, prepared.shellIntegration),
        events: launched.events,
      })),
    );
}

/**
 * Forks the process's supervisor into the service-owned `FiberMap`: every backend fact becomes an effect here, in a
 * fiber the service scope interrupts at shutdown, instead of an unsupervised `runPromise` in a node-pty callback.
 */
function superviseProcess(
  deps: PtyLaunchDependencies,
  ptyProcessId: number,
  events: Stream.Stream<PtyProcessEvent>,
) {
  const onProcessEvent = Effect.fnUntraced(function* (event: PtyProcessEvent) {
    switch (event._tag) {
      case 'ForegroundChanged':
        return yield* recordForegroundCommandState(
          deps.foreground,
          deps.eventBus,
          ptyProcessId,
          event.state,
        );
      case 'LogAppendFailed':
        return yield* Effect.logWarning('Failed to append PTY output').pipe(
          Effect.annotateLogs({ cause: describeOperationalCause(event.cause) }),
        );
      case 'Exited':
        yield* deps.foreground.clear(ptyProcessId);
        return yield* handleExit(
          deps.repository,
          deps.eventBus,
          deps.retry,
          deps.activeAttachments,
          deps.reservations.terminations,
          deps.pendingExits.deferredWrites,
          ptyProcessId,
          { exitCode: event.exitCode, signal: event.signal },
        );
    }
  });
  return FiberMap.run(
    deps.pendingExits.supervisors,
    ptyProcessId,
    events.pipe(Stream.runForEach(onProcessEvent), Effect.annotateLogs({ ptyProcessId })),
  ).pipe(Effect.asVoid);
}

function foldSpawnFailure(
  deps: PtyLaunchDependencies,
  metadata: PtyProcessLaunchMetadata,
  error: PtyStartError,
) {
  return Effect.gen(function* () {
    const message = spawnFailureMessage(metadata.command, metadata.cwd, error);
    yield* Effect.logWarning('PTY process launch failed').pipe(
      Effect.annotateLogs({
        ptyProcessId: metadata.ptyProcessId,
        command: metadata.command,
        cause: describeOperationalCause(error),
      }),
    );
    const failedProcess = yield* deps.repository
      .findProcess(metadata.ptyProcessId)
      .pipe(Effect.orElseSucceed(() => null));
    const failedLogPath = failedProcess?.logPath;
    if (failedLogPath) {
      // Best effort: the message only explains the failure in the log, so an unwritable log must not keep the row from
      // being marked failed.
      yield* Effect.try({
        try: () => appendLog(failedLogPath, message),
        catch: (cause) =>
          new PtyLogError({ operation: 'append', ptyProcessId: metadata.ptyProcessId, cause }),
      }).pipe(
        Effect.catch((logError) =>
          Effect.logWarning('Could not write the PTY launch failure to its log').pipe(
            Effect.annotateLogs({
              ptyProcessId: metadata.ptyProcessId,
              cause: describeOperationalCause(logError),
            }),
          ),
        ),
      );
    }
    yield* markLaunchFailed(deps, metadata.ptyProcessId, 'Could not mark failed PTY launch');
  });
}

/**
 * The cancelled-spawn cleanup. The abort proves only that the client was
 * killed, not that the backend refused the request, so this runs the ordinary
 * outcome-honest termination flow: a live session is killed and persisted, and
 * an absence observation deliberately persists nothing — the row stays
 * `starting` and nonterminal so a later independent observer (the poller, a
 * deletion audit, or the backend-session sweep) owns the terminal fact.
 *
 * Unbounded on purpose. A timeout would need somewhere for the abandoned work
 * to live, and detaching it would let a kill or a write land through services
 * whose scope is already closing.
 */
function cleanupCancelledSpawn(deps: PtyLaunchDependencies, ptyProcessId: number) {
  return terminatePtyProcess({
    repository: deps.repository,
    catalog: deps.catalog,
    eventBus: deps.eventBus,
    activeAttachments: deps.activeAttachments,
    terminations: deps.reservations.terminations,
    retry: deps.retry,
    ptyProcessId,
    reason: 'user_requested',
  }).pipe(
    // Best effort and already decided: a failure leaves the row nonterminal for the poller, as documented above.
    Effect.ignore,
  );
}

// Best-effort terminal marker for a launch that never produced a usable
// process. Absorbed on failure: startup reconciliation and GC own the residue.
function markLaunchFailed(
  deps: PtyLaunchDependencies,
  ptyProcessId: number,
  failureLogMessage: string,
) {
  return transitionProcessByIdAndPublish(deps.repository, deps.eventBus, {
    ptyProcessId,
    status: 'failed',
    statusReason: 'backend_launch_failed',
    exitCode: null,
    signal: null,
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(failureLogMessage).pipe(
        Effect.annotateLogs({ ptyProcessId, cause: describeOperationalCause(error) }),
      ),
    ),
    Effect.asVoid,
  );
}

// Total by contract: the caller already owns a durable row (and possibly a live
// process), so a failed reread degrades the returned metadata to
// `logPath: null` rather than failing the launch. The failure is logged so the
// degraded handoff is explainable rather than silent.
function withPersistedLogPath(
  deps: PtyLaunchDependencies,
  metadata: PtyProcessLaunchMetadata,
): Effect.Effect<PtyProcessLaunchMetadata> {
  return deps.repository.findProcess(metadata.ptyProcessId).pipe(
    Effect.catch((error) =>
      Effect.logWarning(
        'Could not read persisted PTY launch metadata; returning launch result without a log path',
      ).pipe(
        Effect.annotateLogs({
          ptyProcessId: metadata.ptyProcessId,
          cause: describeOperationalCause(error),
        }),
        Effect.as(null),
      ),
    ),
    Effect.map((row) => ({ ...metadata, logPath: row?.logPath ?? null })),
  );
}
