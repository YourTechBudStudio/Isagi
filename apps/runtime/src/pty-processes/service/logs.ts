import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import process from 'node:process';
import { StringDecoder } from 'node:string_decoder';

import { Effect } from 'effect';

import type { PtyProcessLogMode, PtyStreamOutputMessageSet } from '@isagi/contracts';

import { replayUtf8LogFile } from '../log-replay.js';
import type { PtyRepositoryService } from '../pty.repository.js';
import type { PtyProcessRecord } from '../types.js';
import { PtyServiceError } from '../types.js';

const orphanLogSampleSize = 5;

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
        console.warn('[runtime] Could not inspect PTY process logs for orphans', error);
      }),
    ),
  );
}

export function detectOrphanPtyLogs(repository: PtyRepositoryService, sessionsPath: string) {
  return Effect.gen(function* () {
    const referencedLogPaths = new Set((yield* repository.listProcessLogPaths).map(normalizePath));
    const entries = yield* Effect.try({
      try: () => readdirSync(sessionsPath, { withFileTypes: true }),
      catch: (cause) =>
        new PtyServiceError({
          code: 'log_read_failed',
          message: 'Could not inspect PTY process logs.',
          cause,
        }),
    });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ptylog'))
      .map((entry) => join(sessionsPath, entry.name))
      .filter((path) => !referencedLogPaths.has(normalizePath(path)))
      .map((path) => relativeProcessLogPath(sessionsPath, path))
      .sort();
  });
}

export function cleanupOrphanPtyLogs(
  repository: PtyRepositoryService,
  sessionsPath: string,
  options: { readonly minAgeMs: number; readonly nowMs?: number | undefined },
) {
  return Effect.gen(function* () {
    const nowMs = options.nowMs ?? Date.now();
    const referencedLogPaths = new Set((yield* repository.listProcessLogPaths).map(normalizePath));
    const entries = yield* Effect.try({
      try: () => readdirSync(sessionsPath, { withFileTypes: true }),
      catch: (cause) =>
        new PtyServiceError({
          code: 'log_read_failed',
          message: 'Could not inspect PTY process logs.',
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
      const relativePath = relativeProcessLogPath(sessionsPath, path);
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

// The last `maxBytes` of one retained process log, decoded as UTF-8.
//
// Generic on purpose: it knows nothing about who is asking or why. The caller
// owns the bound and the presentation.
export interface PtyLogTail {
  // `null` means nothing was retained — a backend that keeps no file, or a file
  // that no longer exists. It is a different fact from an empty excerpt, which
  // means the log exists and has no bytes in it.
  readonly excerpt: string | null;
  readonly truncated: boolean;
  readonly totalBytes: number | null;
}

const tailChunkBytes = 64 * 1024;

// A UTF-8 continuation byte is `10xxxxxx`. A bounded read can land in the middle
// of a multi-byte character, and decoding from there would emit a replacement
// character that the file itself does not contain — a truncation artefact
// presented as retained output. Advancing is always safe: it only ever drops
// bytes, never exceeds `maxBytes`, and the excerpt is already marked truncated.
function isUtf8ContinuationByte(byte: number) {
  return (byte & 0xc0) === 0x80;
}

// Node's filesystem errors carry an operating-system constant on `code`. This
// only *branches* on it — the value is never rendered, and neither the error nor
// its message reaches a log or a diagnostic — so a plain read is appropriate
// here, unlike the paranoid own-data-descriptor read the redacting classifier
// needs.
function isMissingFile(cause: unknown) {
  return cause instanceof Error && (cause as { readonly code?: unknown }).code === 'ENOENT';
}

export function readPtyLogTail(input: {
  readonly logPath: string | null;
  readonly logMode: PtyProcessLogMode;
  readonly maxBytes: number;
}): Effect.Effect<PtyLogTail, PtyServiceError> {
  const { logPath, logMode, maxBytes } = input;
  // Nothing was ever retained for this incarnation. Not a failure: a backend
  // that keeps no file is a configuration, not a fault.
  if (logMode !== 'backend_file' || !logPath) {
    return Effect.succeed({ excerpt: null, truncated: false, totalBytes: null });
  }

  return Effect.tryPromise({
    try: async (): Promise<PtyLogTail> => {
      let file;
      try {
        file = await open(logPath, 'r');
      } catch (cause) {
        // The row outlived its file: an allocation abandoned before the backend
        // prepared one, or the orphan-log sweep. Same answer as a backend that
        // retains nothing.
        if (isMissingFile(cause)) return { excerpt: null, truncated: false, totalBytes: null };
        throw cause;
      }
      try {
        const totalBytes = (await file.stat()).size;
        if (totalBytes === 0) return { excerpt: '', truncated: false, totalBytes: 0 };

        const wanted = Math.min(maxBytes, totalBytes);
        let offset = totalBytes - wanted;
        const truncated = offset > 0;

        // Only a bounded start can split a character; a tail that begins at zero
        // begins at a character boundary by construction.
        if (truncated) {
          const lead = Buffer.allocUnsafe(1);
          while (offset < totalBytes) {
            const { bytesRead } = await file.read(lead, 0, 1, offset);
            if (bytesRead <= 0) break;
            if (!isUtf8ContinuationByte(lead[0] as number)) break;
            offset += 1;
          }
        }

        const buffer = Buffer.allocUnsafe(Math.min(tailChunkBytes, totalBytes - offset));
        const decoder = new StringDecoder('utf8');
        let excerpt = '';
        while (offset < totalBytes) {
          const toRead = Math.min(buffer.byteLength, totalBytes - offset);
          const { bytesRead } = await file.read(buffer, 0, toRead, offset);
          if (bytesRead <= 0) break;
          offset += bytesRead;
          excerpt += decoder.write(buffer.subarray(0, bytesRead));
        }
        // Any partial character left here is at the physical end of the file, so
        // the replacement reflects what was retained rather than the bound.
        excerpt += decoder.end();

        return { excerpt, truncated, totalBytes };
      } finally {
        await file.close();
      }
    },
    catch: (cause) =>
      new PtyServiceError({
        code: 'log_read_failed',
        message: 'Could not read this process log.',
        cause,
      }),
  });
}

export function replayBytesForProcess(session: PtyProcessRecord) {
  if (session.logMode !== 'backend_file' || !session.logPath) {
    return null;
  }
  try {
    return statSync(session.logPath).size;
  } catch {
    return 0;
  }
}

export function replayProcessLog(input: {
  readonly logPath: string | null;
  readonly bytes: number | null;
  readonly send: (message: PtyStreamOutputMessageSet) => void;
}) {
  return replayUtf8LogFile({
    logPath: input.logPath,
    bytes: input.bytes,
    send: input.send,
    failureMessage: 'Could not replay this session log.',
  });
}

function normalizePath(path: string) {
  return relative(process.cwd(), path);
}

function relativeProcessLogPath(sessionsPath: string, path: string) {
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
