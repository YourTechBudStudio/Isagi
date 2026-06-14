import { closeSync, openSync, readdirSync, readSync, statSync, unlinkSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import process from 'node:process';

import { Effect } from 'effect';

import type { PtyWebSocketOutputMessage } from '@isagi/contracts';

import type { PtySessionRow } from '../../surfaces/index.js';
import type { PtyRepositoryService } from '../pty.repository.js';
import { PtyServiceError } from '../types.js';

const orphanLogSampleSize = 5;
const orphanPtyLogMinAgeMs = 3 * 60 * 60_000;
const orphanPtyLogGcIntervalMs = 60 * 60_000;
const replayChunkBytes = 64 * 1024;

export interface OrphanPtyLogCleanupStats {
  readonly inspected: number;
  readonly deleted: readonly string[];
  readonly skippedYoung: readonly string[];
  readonly failed: readonly string[];
}

export function reportOrphanPtyLogs(repository: PtyRepositoryService, sessionsPath: string) {
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

export function startOrphanPtyLogGcLoop(repository: PtyRepositoryService, sessionsPath: string) {
  const timer = setInterval(() => {
    void Effect.runPromise(
      cleanupOrphanPtyLogs(repository, sessionsPath, { minAgeMs: orphanPtyLogMinAgeMs }).pipe(
        Effect.catchAll((error) =>
          Effect.sync(() => {
            console.warn('[runtime] PTY orphan log cleanup failed', error);
          }),
        ),
      ),
    );
  }, orphanPtyLogGcIntervalMs);
  timer.unref();
  return timer;
}

export function cleanupOrphanPtyLogs(
  repository: PtyRepositoryService,
  sessionsPath: string,
  options: { readonly minAgeMs: number; readonly nowMs?: number | undefined },
) {
  return Effect.gen(function* () {
    const nowMs = options.nowMs ?? Date.now();
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

    const candidates = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ptylog'))
      .map((entry) => join(sessionsPath, entry.name))
      .sort();
    const deleted: string[] = [];
    const skippedYoung: string[] = [];
    const failed: string[] = [];

    for (const path of candidates) {
      const relativePath = relativeSessionLogPath(sessionsPath, path);
      if (referencedLogPaths.has(normalizePath(path))) {
        continue;
      }

      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(path);
      } catch (error) {
        failed.push(relativePath);
        console.warn(`[runtime] Could not inspect orphan PTY log ${relativePath}`, error);
        continue;
      }

      if (!stat.isFile()) {
        continue;
      }

      if (nowMs - stat.mtimeMs < options.minAgeMs) {
        skippedYoung.push(relativePath);
        continue;
      }

      try {
        unlinkSync(path);
        deleted.push(relativePath);
      } catch (error) {
        failed.push(relativePath);
        console.warn(`[runtime] Could not delete orphan PTY log ${relativePath}`, error);
      }
    }

    logOrphanPtyLogCleanupSummary({ inspected: candidates.length, deleted, skippedYoung, failed });

    return {
      inspected: candidates.length,
      deleted,
      skippedYoung,
      failed,
    } satisfies OrphanPtyLogCleanupStats;
  });
}

export function replayBytesForSession(session: PtySessionRow) {
  if (session.logMode !== 'backend_file' || !session.logPath) {
    return null;
  }
  try {
    return statSync(session.logPath).size;
  } catch {
    return 0;
  }
}

export function replaySessionLog(input: {
  readonly logPath: string | null;
  readonly bytes: number | null;
  readonly send: (message: PtyWebSocketOutputMessage) => void;
}) {
  return Effect.try({
    try: () => {
      const bytes = input.logPath ? (input.bytes ?? statSync(input.logPath).size) : 0;
      input.send({ type: 'replay_start', bytes });
      if (input.logPath && bytes > 0) {
        const fd = openSync(input.logPath, 'r');
        try {
          const buffer = Buffer.allocUnsafe(Math.min(replayChunkBytes, bytes));
          let offset = 0;
          while (offset < bytes) {
            const toRead = Math.min(buffer.byteLength, bytes - offset);
            const read = readSync(fd, buffer, 0, toRead, offset);
            if (read <= 0) {
              break;
            }
            offset += read;
            input.send({ type: 'output', data: buffer.toString('utf8', 0, read), replay: true });
          }
        } finally {
          closeSync(fd);
        }
      }
      input.send({ type: 'replay_end' });
    },
    catch: (cause) =>
      new PtyServiceError({
        code: 'log_read_failed',
        message: 'Could not replay this session log.',
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

function logOrphanPtyLogCleanupSummary(stats: OrphanPtyLogCleanupStats) {
  if (stats.deleted.length > 0) {
    const sample = stats.deleted.slice(0, orphanLogSampleSize).join(', ');
    const suffix = stats.deleted.length > orphanLogSampleSize ? ', ...' : '';
    console.info(
      `[runtime] Deleted ${stats.deleted.length} orphan PTY log file(s): ${sample}${suffix}`,
    );
  }

  if (stats.failed.length > 0) {
    const sample = stats.failed.slice(0, orphanLogSampleSize).join(', ');
    const suffix = stats.failed.length > orphanLogSampleSize ? ', ...' : '';
    console.warn(
      `[runtime] Failed to clean ${stats.failed.length} orphan PTY log file(s): ${sample}${suffix}`,
    );
  }
}
