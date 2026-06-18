import { unlinkSync } from 'node:fs';

import { Effect, Either } from 'effect';

import type { PtyProcessRow } from '../../surfaces/index.js';
import type { PtyRepositoryService } from '../pty.repository.js';
import type { PtyBackend, PtyBackendGcFinding, PtyBackendGcSession } from '../types.js';
import { decodeBackendRef } from './backend-ref.js';
import { cleanupOrphanPtyLogs } from './logs.js';

const ptyGcIntervalMs = 5 * 60_000;
const orphanPtyProcessRetentionMs = 5 * 60_000;

export function startPtyGarbageCollector(
  repository: PtyRepositoryService,
  backend: PtyBackend,
  runtimeNamespace: string,
  sessionsPath: string,
) {
  const timer = setInterval(() => {
    void Effect.runPromise(
      collectPtyGarbage(repository, backend, runtimeNamespace, sessionsPath).pipe(
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
  options: { readonly nowMs?: number | undefined } = {},
) {
  return Effect.gen(function* () {
    yield* cleanupBackendProcesses(repository, backend, runtimeNamespace);
    yield* cleanupOrphanPtyProcesses(repository, backend, options.nowMs ?? Date.now());
    yield* cleanupOrphanPtyLogs(repository, sessionsPath, {
      minAgeMs: orphanPtyProcessRetentionMs,
      nowMs: options.nowMs,
    });
  });
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
  nowMs: number,
) {
  return Effect.gen(function* () {
    const processes = yield* repository.listOrphanProcesses;
    for (const process of processes) {
      if (!isRetentionElapsed(process.updatedAt, nowMs)) continue;
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
    if (!ref) return true;

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
