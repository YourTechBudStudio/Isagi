import { unlinkSync } from 'node:fs';

import { Effect, Either } from 'effect';

import type { PtyProcessRow } from '../../surfaces/index.js';
import type { PtyRepositoryService } from '../pty.repository.js';
import type { PtyBackend, PtyBackendGcFinding, PtyBackendGcSession } from '../types.js';
import { decodeBackendRef } from './backend-ref.js';
import { cleanupOrphanPtyLogs } from './logs.js';

const ptyGcIntervalMs = 5 * 60_000;
const orphanPtyProcessRetentionMs = 5 * 60_000;
// Stray log files (no DB row) share the process retention window by design: a
// log only reaches this age gate after its row has already been deleted by the
// orphan-process phase, so the window just absorbs clock skew and a crash
// between row deletion and log deletion. One retention concept, not two.
const orphanPtyLogRetentionMs = orphanPtyProcessRetentionMs;

export function startPtyGarbageCollector(
  repository: PtyRepositoryService,
  backend: PtyBackend,
  runtimeNamespace: string,
  sessionsPath: string,
  options: {
    readonly pinnedPtyProcessIds?: ReadonlySet<number> | undefined;
  } = {},
) {
  const timer = setInterval(() => {
    void Effect.runPromise(
      collectPtyGarbage(repository, backend, runtimeNamespace, sessionsPath, options).pipe(
        Effect.catchAll((error) =>
          Effect.sync(() => {
            console.warn('[runtime] PTY GC failed', error);
          }),
        ),
      ),
    );
  }, ptyGcIntervalMs);
  timer.unref();
  return timer;
}

export function collectPtyGarbage(
  repository: PtyRepositoryService,
  backend: PtyBackend,
  runtimeNamespace: string,
  sessionsPath: string,
  options: {
    readonly nowMs?: number | undefined;
    readonly pinnedPtyProcessIds?: ReadonlySet<number> | undefined;
  } = {},
) {
  return Effect.gen(function* () {
    yield* cleanupBackendProcesses(repository, backend, runtimeNamespace).pipe(
      tagGcPhaseError('backend_processes'),
    );
    yield* cleanupOrphanPtyProcesses(repository, backend, {
      nowMs: options.nowMs ?? Date.now(),
      pinnedPtyProcessIds: options.pinnedPtyProcessIds ?? new Set(),
    }).pipe(tagGcPhaseError('orphan_processes'));
    yield* cleanupOrphanPtyLogs(repository, sessionsPath, {
      minAgeMs: orphanPtyLogRetentionMs,
      nowMs: options.nowMs,
    }).pipe(tagGcPhaseError('orphan_logs'));
  });
}

// Names the phase on the way out so the top-level GC failure log points at the
// sub-phase that aborted, without swallowing the failure.
function tagGcPhaseError<A, E, R>(phase: string) {
  return (effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          console.warn(`[runtime] PTY GC phase failed phase=${phase}`, error);
        }),
      ),
    );
}

function cleanupBackendProcesses(
  repository: PtyRepositoryService,
  backend: PtyBackend,
  runtimeNamespace: string,
) {
  return Effect.gen(function* () {
    if (!backend.collectGarbage) return;
    const sessions = yield* collectGcSessions(repository);
    const findings = yield* backend.collectGarbage({ runtimeNamespace, sessions }).pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => {
          console.warn(
            `[runtime] Could not collect PTY backend GC findings backend=${backend.name}`,
            error,
          );
          return [];
        }),
      ),
    );
    for (const finding of findings) {
      yield* applyGcFinding(backend, finding);
    }
  });
}

function cleanupOrphanPtyProcesses(
  repository: PtyRepositoryService,
  backend: PtyBackend,
  options: {
    readonly nowMs: number;
    readonly pinnedPtyProcessIds: ReadonlySet<number>;
  },
) {
  return Effect.gen(function* () {
    const processes = yield* repository.listOrphanProcesses;
    for (const process of processes) {
      if (options.pinnedPtyProcessIds.has(process.id)) {
        console.info(
          `[runtime] Keeping orphan PTY process because it is pinned ptyProcessId=${process.id}`,
        );
        continue;
      }
      if (!isRetentionElapsed(process.updatedAt, options.nowMs)) continue;
      yield* cleanupOrphanPtyProcess(repository, backend, process);
    }
  });
}

function cleanupOrphanPtyProcess(
  repository: PtyRepositoryService,
  backend: PtyBackend,
  process: PtyProcessRow,
) {
  return Effect.gen(function* () {
    if (process.status === 'starting' || process.status === 'running') {
      const backendCleaned = yield* cleanupLiveOrphanPtyBackend(backend, process);
      if (!backendCleaned) return;
    }

    const logCleaned = cleanupPtyProcessLog(process);
    if (!logCleaned) return;

    yield* repository.deleteProcess(process.id);
    console.info(`[runtime] Deleted orphan PTY process ptyProcessId=${process.id}`);
  });
}

function cleanupLiveOrphanPtyBackend(backend: PtyBackend, process: PtyProcessRow) {
  return Effect.gen(function* () {
    if (process.backend !== backend.name) {
      console.warn(
        `[runtime] Keeping orphan PTY process because backend is unavailable backend=${process.backend} ptyProcessId=${process.id}`,
      );
      return false;
    }

    const ref = yield* decodeBackendRef(process).pipe(Effect.orElseSucceed(() => null));
    if (!ref) {
      // The row claims a live process but its backend ref is undecodable, so we
      // cannot inspect or kill it. Keep the row rather than orphaning a possibly
      // live backend process with no durable record pointing at it.
      console.warn(
        `[runtime] Keeping orphan PTY process because backend ref is undecodable backend=${backend.name} ptyProcessId=${process.id}`,
      );
      return false;
    }

    const inspection = yield* backend
      .inspect(ref)
      .pipe(Effect.catchAll((cause) => Effect.succeed({ status: 'unavailable' as const, cause })));
    if (inspection.status === 'missing') return true;
    if (inspection.status === 'unavailable') {
      console.warn(
        `[runtime] Keeping orphan PTY process because backend inspection is unavailable backend=${backend.name} ptyProcessId=${process.id}`,
        inspection.cause,
      );
      return false;
    }

    const killResult = yield* backend.kill(ref).pipe(Effect.either);
    if (Either.isLeft(killResult)) {
      console.warn(
        `[runtime] Keeping orphan PTY process because backend kill failed backend=${backend.name} ptyProcessId=${process.id}`,
        killResult.left,
      );
      return false;
    }
    return true;
  });
}

function cleanupPtyProcessLog(process: PtyProcessRow) {
  if (!process.logPath) return true;
  try {
    unlinkSync(process.logPath);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return true;
    console.warn(`[runtime] Could not delete PTY process log ptyProcessId=${process.id}`, error);
    return false;
  }
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

function collectGcSessions(repository: PtyRepositoryService) {
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
  console.warn(
    `[runtime] Killing ${reason} during PTY backend GC backend=${backend.name} ptyProcessId=${finding.ptyProcessId}`,
  );
  return backend.kill(finding.ref).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        console.warn(
          `[runtime] Failed to kill PTY backend session during GC backend=${backend.name} ptyProcessId=${finding.ptyProcessId}`,
          error,
        );
      }),
    ),
  );
}
