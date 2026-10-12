import { unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

import { Effect, Result } from 'effect';

import { describeOperationalCause, diagnosticPhase } from '../../platform/diagnostics/index.js';
import {
  isIdName,
  listOrphanCandidates,
  openCollectorRoot,
  sweepOrphans,
} from '../../platform/persistence/index.js';
import type { PtyBackendCatalog } from '../backend.js';
import type { PtyRepository } from '../repository.js';
import type {
  PtyProcessRow,
  PtyBackend,
  PtyBackendGcFinding,
  PtyBackendGcSession,
} from '../types.js';
import { decodeBackendRef } from './backend-ref.js';
import { isExitPending, type PtyLaunchReservations, type PtyPendingExits } from './lifecycle.js';
import { cleanupOrphanPtyLogs } from './logs.js';
import { shellIntegrationSegments } from './shell-integration.js';

const orphanPtyProcessRetentionMs = 5 * 60_000;
// Stray log files (no DB row) share the process retention window by design: a
// log only reaches this age gate after its row has already been deleted by the
// orphan-process phase, so the window just absorbs clock skew and a crash
// between row deletion and log deletion. One retention concept, not two.
// Shell-integration folders reuse it for the same reason: the row is allocated
// before the folder is written, and only this GC deletes rows, after the
// process is gone.
const orphanPtyLogRetentionMs = orphanPtyProcessRetentionMs;
const orphanShellIntegrationRetentionMs = orphanPtyProcessRetentionMs;

export function collectPtyGarbage(
  repository: PtyRepository['Service'],
  catalog: PtyBackendCatalog['Service'],
  runtimeNamespace: string,
  sessionsPath: string,
  options: {
    readonly nowMs?: number | undefined;
    readonly pinnedPtyProcessIds?: ReadonlySet<number> | undefined;
    // A launch that has allocated its row but not yet produced a process. Its
    // row is legitimately unreferenced until the caller's handoff, so without
    // this exclusion a spawn slower than the retention window could have its
    // row and its live process collected mid-launch.
    readonly pendingLaunches?: PtyLaunchReservations | undefined;
    // Exits the backend reported but the row does not record yet (`isExitPending`): while one is pending, a backend
    // `missing` is that exit, so the orphan row is kept for a later pass instead of being collected under its write.
    readonly pendingExits?: PtyPendingExits | undefined;
  } = {},
) {
  return Effect.gen(function* () {
    yield* diagnosticPhase(
      'pty.gc.backend_processes',
      { runtimeNamespace },
      cleanupBackendProcesses(repository, catalog, runtimeNamespace),
    ).pipe(tagGcPhaseError('backend_processes'));
    yield* diagnosticPhase(
      'pty.gc.orphan_processes',
      {},
      cleanupOrphanPtyProcesses(repository, catalog, {
        nowMs: options.nowMs ?? Date.now(),
        pinnedPtyProcessIds: options.pinnedPtyProcessIds ?? new Set(),
        pendingLaunches: options.pendingLaunches ?? new Map(),
        pendingExits: options.pendingExits,
      }),
    ).pipe(tagGcPhaseError('orphan_processes'));
    yield* diagnosticPhase(
      'pty.gc.orphan_logs',
      { sessionsPath },
      cleanupOrphanPtyLogs(repository, sessionsPath, {
        minAgeMs: orphanPtyLogRetentionMs,
        nowMs: options.nowMs,
      }),
    ).pipe(tagGcPhaseError('orphan_logs'));
    // Contained, unlike its siblings: folder collection is housekeeping and must
    // never fail the GC pass (which would fail the startup pass in PtyService.layer).
    yield* diagnosticPhase(
      'pty.gc.orphan_shell_integration',
      { sessionsPath },
      cleanupOrphanShellIntegration(repository, sessionsPath, {
        minAgeMs: orphanShellIntegrationRetentionMs,
        nowMs: options.nowMs ?? Date.now(),
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning('PTY GC phase failed', cause).pipe(
          Effect.annotateLogs({ phase: 'orphan_shell_integration' }),
        ),
      ),
    );
  });
}

// Deletes `sessions/shell-integration/<ptyProcessId>/` folders that no PTY row
// references once they are older than the retention window.
function cleanupOrphanShellIntegration(
  repository: PtyRepository['Service'],
  sessionsPath: string,
  options: { readonly minAgeMs: number; readonly nowMs: number },
) {
  return Effect.gen(function* () {
    // Mark before listing, so a folder written after the mark is listed only
    // with a row the mark may lack — and that folder is young.
    const liveIds = new Set((yield* repository.listProcesses()).map((row) => row.id));
    const label = 'shell integration folder';
    // `sessionsPath` is `<data root>/sessions`, so its parent is the canonical data root.
    const opened = yield* openCollectorRoot(dirname(sessionsPath), shellIntegrationSegments, label);
    if (opened.status !== 'ready') return;
    const listing = yield* listOrphanCandidates(opened.directory, 'directory', isIdName, label);
    if (listing.status !== 'listed') return;
    yield* sweepOrphans({
      label,
      candidates: listing.candidates,
      isLive: (candidate) => liveIds.has(Number(candidate.name)),
      minAgeMs: options.minAgeMs,
      nowMs: options.nowMs,
    });
  });
}

// Names the phase on the way out so the top-level GC failure log points at the
// sub-phase that aborted, without swallowing the failure.
function tagGcPhaseError<A, E, R>(phase: string) {
  return (effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tapError((error) =>
        Effect.logWarning('PTY GC phase failed').pipe(
          Effect.annotateLogs({ phase, cause: describeOperationalCause(error) }),
        ),
      ),
    );
}

// Backend-only sessions have no persisted row to dispatch from, so this sweep
// cannot be driven by the rows the runtime knows about — gating it on persisted
// tmux rows would miss exactly the orphans it exists to find. Every registered
// adapter that is actually available therefore collects, whatever the current
// launch preference is.
function cleanupBackendProcesses(
  repository: PtyRepository['Service'],
  catalog: PtyBackendCatalog['Service'],
  runtimeNamespace: string,
) {
  return Effect.gen(function* () {
    const sessions = yield* collectGcSessions(repository);
    for (const backend of catalog.all) {
      if (!backend.collectGarbage) continue;
      if (!(yield* backend.available)) continue;
      const findings = yield* backend.collectGarbage({ runtimeNamespace, sessions }).pipe(
        Effect.catch((error) =>
          Effect.logWarning('Could not collect PTY backend GC findings').pipe(
            Effect.annotateLogs({
              backend: backend.name,
              cause: describeOperationalCause(error),
            }),
            Effect.as([] as readonly PtyBackendGcFinding[]),
          ),
        ),
      );
      for (const finding of findings) {
        yield* applyGcFinding(backend, finding);
      }
    }
  });
}

function cleanupOrphanPtyProcesses(
  repository: PtyRepository['Service'],
  catalog: PtyBackendCatalog['Service'],
  options: {
    readonly nowMs: number;
    readonly pinnedPtyProcessIds: ReadonlySet<number>;
    readonly pendingLaunches: PtyLaunchReservations;
    readonly pendingExits: PtyPendingExits | undefined;
  },
) {
  return Effect.gen(function* () {
    const processes = yield* repository.listOrphanProcesses;
    yield* Effect.logDebug('pty.gc.orphan_processes_discovered').pipe(
      Effect.annotateLogs({
        orphanCount: processes.length,
        pinnedCount: options.pinnedPtyProcessIds.size,
        pendingLaunchCount: options.pendingLaunches.size,
      }),
    );
    for (const process of processes) {
      yield* Effect.logDebug('pty.gc.orphan_process_considered').pipe(
        Effect.annotateLogs({
          ptyProcessId: process.id,
          backend: process.backend,
          status: process.status,
          statusReason: process.statusReason,
          cwd: process.cwd,
          pinned: options.pinnedPtyProcessIds.has(process.id),
          pendingLaunch: options.pendingLaunches.has(process.id),
          retentionElapsed: isRetentionElapsed(process.updatedAt, options.nowMs),
        }),
      );
      if (options.pinnedPtyProcessIds.has(process.id)) {
        yield* Effect.logInfo('Keeping orphan PTY process because it is pinned').pipe(
          Effect.annotateLogs({ ptyProcessId: process.id }),
        );
        continue;
      }
      // Distinct from pinning on purpose: pinning is a caller's explicit
      // retention request, while this is a launch that has not finished yet.
      // Reporting one as the other would make the GC log lie about why the row
      // survived.
      if (options.pendingLaunches.has(process.id)) {
        yield* Effect.logInfo(
          'Keeping orphan PTY process because its launch is still pending',
        ).pipe(Effect.annotateLogs({ ptyProcessId: process.id }));
        continue;
      }
      if (!isRetentionElapsed(process.updatedAt, options.nowMs)) continue;
      yield* diagnosticPhase(
        'pty.gc.cleanup_orphan_process',
        {
          ptyProcessId: process.id,
          backend: process.backend,
          status: process.status,
          statusReason: process.statusReason,
          cwd: process.cwd,
        },
        cleanupOrphanPtyProcess(repository, catalog, process, options.pendingExits),
      );
    }
  });
}

function cleanupOrphanPtyProcess(
  repository: PtyRepository['Service'],
  catalog: PtyBackendCatalog['Service'],
  process: PtyProcessRow,
  pendingExits: PtyPendingExits | undefined,
) {
  return Effect.gen(function* () {
    if (process.status === 'starting' || process.status === 'running') {
      const backendCleaned = yield* cleanupLiveOrphanPtyBackend(
        yield* catalog.forBackend(process.backend),
        process,
        pendingExits,
      );
      if (!backendCleaned) return;
    }

    const logCleaned = yield* cleanupPtyProcessLog(process);
    if (!logCleaned) return;

    yield* repository.deleteProcess(process.id);
    yield* Effect.logInfo('Deleted orphan PTY process').pipe(
      Effect.annotateLogs({ ptyProcessId: process.id }),
    );
  });
}

function cleanupLiveOrphanPtyBackend(
  backend: PtyBackend,
  process: PtyProcessRow,
  pendingExits: PtyPendingExits | undefined,
) {
  return Effect.gen(function* () {
    const ref = yield* decodeBackendRef(process).pipe(Effect.orElseSucceed(() => null));
    if (!ref) {
      // The row claims a live process but its backend ref is undecodable, so we
      // cannot inspect or kill it. Keep the row rather than orphaning a possibly
      // live backend process with no durable record pointing at it.
      yield* Effect.logWarning(
        'Keeping orphan PTY process because backend ref is undecodable',
      ).pipe(Effect.annotateLogs({ backend: backend.name, ptyProcessId: process.id }));
      return false;
    }

    const inspection = yield* backend
      .inspect(ref)
      .pipe(Effect.catch((cause) => Effect.succeed({ status: 'unavailable' as const, cause })));
    if (inspection.status === 'missing') {
      // An exit the backend reported but the row does not record yet: collecting the row now would race that write.
      // The next pass finds the row terminal and collects it then.
      if (pendingExits && isExitPending(pendingExits, process.id)) {
        yield* Effect.logInfo(
          'Keeping orphan PTY process because its exit is still being recorded',
        ).pipe(Effect.annotateLogs({ backend: backend.name, ptyProcessId: process.id }));
        return false;
      }
      return true;
    }
    if (inspection.status === 'unavailable') {
      yield* Effect.logWarning(
        'Keeping orphan PTY process because backend inspection is unavailable',
      ).pipe(
        Effect.annotateLogs({
          backend: backend.name,
          ptyProcessId: process.id,
          cause: describeOperationalCause(inspection.cause),
        }),
      );
      return false;
    }

    const killResult = yield* backend.kill(ref).pipe(Effect.result);
    if (Result.isFailure(killResult)) {
      yield* Effect.logWarning('Keeping orphan PTY process because backend kill failed').pipe(
        Effect.annotateLogs({
          backend: backend.name,
          ptyProcessId: process.id,
          cause: describeOperationalCause(killResult.failure),
        }),
      );
      return false;
    }
    return true;
  });
}

function cleanupPtyProcessLog(process: PtyProcessRow) {
  const logPath = process.logPath;
  if (!logPath) return Effect.succeed(true);
  return Effect.try({
    try: () => unlinkSync(logPath),
    catch: (error) => error,
  }).pipe(
    Effect.as(true),
    Effect.catch((error) =>
      isMissingFileError(error)
        ? Effect.succeed(true)
        : Effect.logWarning('Could not delete PTY process log').pipe(
            Effect.annotateLogs({
              ptyProcessId: process.id,
              cause: describeOperationalCause(error),
            }),
            Effect.as(false),
          ),
    ),
  );
}

// Retention is measured from `updatedAt`, which is only bumped on a real status
// transition (not on session deletion). So the clock effectively starts at the
// row's last status change, not the moment it became an orphan. This errs toward
// longer retention for steady-state rows, which is the safe direction.
function isRetentionElapsed(updatedAt: string, nowMs: number) {
  const updatedMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedMs)) return true;
  return nowMs - updatedMs >= orphanPtyProcessRetentionMs;
}

function isMissingFileError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  );
}

function collectGcSessions(repository: PtyRepository['Service']) {
  return Effect.gen(function* () {
    const sessions = yield* repository.listProcesses();
    const decoded: PtyBackendGcSession[] = [];
    for (const session of sessions) {
      const ref = yield* decodeBackendRef(session).pipe(Effect.orElseSucceed(() => null));
      if (!ref) {
        continue;
      }
      decoded.push({ ptyProcessId: session.id, ref, status: session.status });
    }
    return decoded;
  });
}

function applyGcFinding(backend: PtyBackend, finding: PtyBackendGcFinding) {
  const reason =
    finding.type === 'orphan_backend_session'
      ? 'orphan backend session'
      : `terminal ${finding.status} PTY row`;
  const annotations = { backend: backend.name, ptyProcessId: finding.ptyProcessId };
  return Effect.logWarning(`Killing ${reason} during PTY backend GC`).pipe(
    Effect.annotateLogs(annotations),
    Effect.andThen(backend.kill(finding.ref)),
    Effect.catch((error) =>
      Effect.logWarning('Failed to kill PTY backend session during GC').pipe(
        Effect.annotateLogs({ ...annotations, cause: describeOperationalCause(error) }),
      ),
    ),
  );
}
