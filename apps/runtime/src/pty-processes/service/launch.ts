import { existsSync } from 'node:fs';

import { Effect, Either } from 'effect';

import type { DatabaseError } from '../../persistence/index.js';
import type { InternalRuntimeEventBusService } from '../../runtime-events/index.js';
import type { PtyBackendCatalogService } from '../backend.js';
import type { PtyForegroundStateService } from '../foreground-state.js';
import { appendLog, type PtyRepositoryService } from '../pty.repository.js';
import {
  type BackendSessionRef,
  type LaunchPtyProcessInput,
  type PtyBackend as PtyBackendShape,
  type PtyProcessAllocation,
  type PtyProcessLaunchMetadata,
  type PtyStartError,
} from '../types.js';
import type { ActiveAttachment } from './attachments.js';
import { backendMetadataForLaunch } from './backend-ref.js';
import { recordForegroundCommandState, transitionProcessByIdAndPublish } from './events.js';
import { backendLaunchCommand } from './launch-mode.js';
import { handleExit, releaseLaunch, reserveLaunch, type PtyReservations } from './lifecycle.js';
import type { PtyRetryScheduler } from './retry.js';
import { spawnFailureMessage } from './runtime-namespace.js';
import { prepareShellIntegration, refWithShellIntegrationToken } from './shell-integration.js';
import type { ShellIntegrationConfig } from './shell-integration.js';
import { terminatePtyProcess } from './termination.js';

const defaultCols = 100;
const defaultRows = 30;

export interface PtyLaunchDependencies {
  readonly repository: PtyRepositoryService;
  readonly catalog: PtyBackendCatalogService;
  readonly eventBus: InternalRuntimeEventBusService;
  readonly foreground: PtyForegroundStateService;
  readonly retry: PtyRetryScheduler;
  readonly reservations: PtyReservations;
  readonly activeAttachments: Map<number, ActiveAttachment>;
  readonly runtimeNamespace: string;
  readonly sessionsPath: string;
  readonly userProcessEnvironment: NodeJS.ProcessEnv;
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
      `[runtime] Could not mark abandoned PTY launch allocation ptyProcessId=${ptyProcessId}`,
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
 * Total for every uninterrupted path: expected pre-spawn (`DatabaseError`) and
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
        Effect.either,
        // Quiescence-safe: nothing has reached a backend yet, so no session can
        // ever materialize for this row and a terminal write is honest.
        Effect.onInterrupt(() =>
          markLaunchFailed(
            deps,
            ptyProcessId,
            `[runtime] Could not mark cancelled PTY launch ptyProcessId=${ptyProcessId}`,
          ),
        ),
      );
      if (Either.isLeft(prepared)) {
        console.warn(
          `[runtime] PTY process launch preparation failed ptyProcessId=${ptyProcessId} command=${metadata.command}`,
          prepared.left,
        );
        yield* markLaunchFailed(
          deps,
          ptyProcessId,
          `[runtime] Could not mark failed PTY launch ptyProcessId=${ptyProcessId}`,
        );
        return yield* withPersistedLogPath(deps, metadata);
      }

      const spawned = yield* restore(spawnBackendProcess(deps, prepared.right, metadata)).pipe(
        Effect.either,
        Effect.onInterrupt(() => cleanupCancelledSpawn(deps, ptyProcessId)),
      );
      if (Either.isLeft(spawned)) {
        yield* foldSpawnFailure(deps, metadata, spawned.left);
        return yield* withPersistedLogPath(deps, metadata);
      }

      // Past this point nothing is load-bearing for ownership: the process is
      // durably inspectable and killable through the metadata written before the
      // spawn. A persistence failure here is logged and absorbed rather than
      // compensated with a kill, and the released reservation lets the status
      // poller heal a row still sitting at `starting`.
      yield* deps.repository
        .updateBackendRef({
          ptyProcessId,
          backendRefJson: JSON.stringify(spawned.right),
        })
        .pipe(
          Effect.zipRight(
            transitionProcessByIdAndPublish(deps.repository, deps.eventBus, {
              ptyProcessId,
              status: 'running',
              statusReason: null,
              exitCode: null,
              signal: null,
            }),
          ),
          Effect.catchAll((error) =>
            Effect.sync(() => {
              console.warn(
                `[runtime] Could not persist PTY launch result; the process is live and the poller will reconcile it ptyProcessId=${ptyProcessId}`,
                error,
              );
            }),
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
): Effect.Effect<PreparedLaunch, DatabaseError> {
  return Effect.gen(function* () {
    // `foreground.clear` and `envForProcess` have empty expected-error channels
    // by contract, so nothing they raise is folded into a launch failure.
    yield* deps.foreground.clear(ptyProcessId);
    const processEnvironment: NodeJS.ProcessEnv = {
      ...deps.userProcessEnvironment,
      ...input.envOverrides,
      ...(input.envForProcess ? yield* input.envForProcess({ ptyProcessId }) : {}),
    };
    const backendCommand = backendLaunchCommand({ launch: input, env: processEnvironment });
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
      ? deps.catalog.forBackend(input.backend)
      : deps.catalog.configured;
    const backendMetadata = backendMetadataForLaunch(
      backend,
      { ptyProcessId, logPath: null },
      deps.runtimeNamespace,
      deps.sessionsPath,
    );
    if (backendMetadata.logPath && !existsSync(backendMetadata.logPath)) {
      appendLog(backendMetadata.logPath, '');
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
  deps: PtyLaunchDependencies,
  prepared: PreparedLaunch,
  metadata: PtyProcessLaunchMetadata,
): Effect.Effect<BackendSessionRef, PtyStartError> {
  return prepared.backend
    .launch({
      ptyProcessId: metadata.ptyProcessId,
      backendSessionName: prepared.backendSessionName,
      command: prepared.command,
      args: prepared.args,
      cwd: metadata.cwd,
      env: prepared.env,
      shellIntegration: prepared.shellIntegration,
      onForegroundCommand: (event) =>
        void Effect.runPromise(
          recordForegroundCommandState(
            deps.foreground,
            deps.eventBus,
            event.ptyProcessId,
            event.state,
          ),
        ),
      cols: defaultCols,
      rows: defaultRows,
      logPath: prepared.logPath,
      onExit: (exit) =>
        void Effect.runPromise(
          deps.foreground
            .clear(metadata.ptyProcessId)
            .pipe(
              Effect.zipRight(
                handleExit(
                  deps.repository,
                  deps.eventBus,
                  deps.retry,
                  deps.activeAttachments,
                  deps.reservations.terminations,
                  metadata.ptyProcessId,
                  exit,
                ),
              ),
            ),
        ),
    })
    .pipe(Effect.map((ref) => refWithShellIntegrationToken(ref, prepared.shellIntegration)));
}

function foldSpawnFailure(
  deps: PtyLaunchDependencies,
  metadata: PtyProcessLaunchMetadata,
  error: PtyStartError,
) {
  return Effect.gen(function* () {
    const message = spawnFailureMessage(metadata.command, metadata.cwd, error);
    console.warn(
      `[runtime] PTY process launch failed ptyProcessId=${metadata.ptyProcessId} command=${metadata.command}`,
      error,
    );
    const failedProcess = yield* deps.repository
      .findProcess(metadata.ptyProcessId)
      .pipe(Effect.orElseSucceed(() => null));
    if (failedProcess?.logPath) appendLog(failedProcess.logPath, message);
    yield* markLaunchFailed(
      deps,
      metadata.ptyProcessId,
      `[runtime] Could not mark failed PTY launch ptyProcessId=${metadata.ptyProcessId}`,
    );
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
  }).pipe(Effect.ignore);
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
    Effect.catchAll((error) => Effect.sync(() => console.warn(failureLogMessage, error))),
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
    Effect.catchAll((error) =>
      Effect.sync(() => {
        console.warn(
          `[runtime] Could not read persisted PTY launch metadata; returning launch result without a log path ptyProcessId=${metadata.ptyProcessId}`,
          error,
        );
        return null;
      }),
    ),
    Effect.map((row) => ({ ...metadata, logPath: row?.logPath ?? null })),
  );
}
