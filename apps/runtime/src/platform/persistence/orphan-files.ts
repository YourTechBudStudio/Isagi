import { lstatSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { Effect } from 'effect';

import { describeOperationalCause } from '../diagnostics/index.js';

// Shared mark-and-sweep helpers for the runtime's file-writing areas. Actions
// delete rows only; each area collects its own files on its own timer by
// listing its root and deleting entries no row references once they are old
// enough. These helpers hold the two rules every collector relies on:
//
// - Nothing is reached through a symbolic link at any depth below the data
//   root. Deletion targets are only `join(guardedDirectory, listedName)`, never
//   a path read from a row, and every directory from the data root down to a
//   candidate is re-checked with lstat in the same synchronous step that
//   removes it.
// - Filesystem conditions never fail the returned effects. They become statuses
//   and log lines, so a collector tick always finishes and the next tick
//   retries. Logged causes go through `describeOperationalCause`.
//
// The per-candidate decide-and-remove step is one synchronous section on
// purpose: an in-process writer whose claim is a synchronous update of the
// state `isLive` reads is either fully before or fully after it, without a lock.

const sweepBatchSize = 64;
const summarySampleSize = 5;

/**
 * A directory reached from the data root through real directories only. `guards` lists every
 * directory from the first component below the data root down to and including `path`; each must
 * still be a real directory (lstat, not a symlink) whenever something inside it is removed.
 */
export interface GuardedDirectory {
  readonly path: string;
  readonly guards: readonly string[];
}

export type GuardedDirectoryResult =
  | { readonly status: 'ready'; readonly directory: GuardedDirectory }
  // ENOENT on any component: nothing to collect, no log.
  | { readonly status: 'absent' }
  // A component is a symlink or not a directory, or lstat failed otherwise: one warning.
  | { readonly status: 'unusable' };

/** `dataRoot` is `DataDirectory.paths.root`, already canonical (realpath) by `isagiDataDirectoryPaths`. */
export const openCollectorRoot = Effect.fnUntraced(function* (
  dataRoot: string,
  segments: readonly string[],
  label: string,
) {
  let directory: GuardedDirectory = { path: dataRoot, guards: [] };
  for (const segment of segments) {
    const next = yield* childDirectory(directory, segment, label);
    if (next.status !== 'ready') return next;
    directory = next.directory;
  }
  const result: GuardedDirectoryResult = { status: 'ready', directory };
  return result;
});

/** One more level below a guarded directory, with the same lstat rule. */
export const childDirectory = Effect.fnUntraced(function* (
  parent: GuardedDirectory,
  name: string,
  label: string,
) {
  const path = join(parent.path, name);
  const inspection = inspectDirectory(path);
  if (inspection.status === 'missing') return absentDirectory;
  if (inspection.status === 'not_real') {
    yield* Effect.logWarning('Skipping orphan collection: not a real directory').pipe(
      Effect.annotateLogs({ collector: label, path }),
    );
    return unusableDirectory;
  }
  if (inspection.status === 'failed') {
    yield* Effect.logWarning('Skipping orphan collection: could not inspect a directory').pipe(
      Effect.annotateLogs({
        collector: label,
        path,
        cause: describeOperationalCause(inspection.error),
      }),
    );
    return unusableDirectory;
  }
  const result: GuardedDirectoryResult = {
    status: 'ready',
    directory: { path, guards: [...parent.guards, path] },
  };
  return result;
});

const absentDirectory: GuardedDirectoryResult = { status: 'absent' };
const unusableDirectory: GuardedDirectoryResult = { status: 'unusable' };

function inspectDirectory(
  path: string,
):
  | { readonly status: 'real' | 'not_real' | 'missing' }
  | { readonly status: 'failed'; readonly error: unknown } {
  try {
    return { status: isRealDirectory(path) ? 'real' : 'not_real' };
  } catch (error) {
    return isMissingFileError(error) ? { status: 'missing' } : { status: 'failed', error };
  }
}

export interface OrphanCandidate {
  /** The listed entry name: the collector's identity key (numeric id, `<hash>.json`, `<uuid>.tmp`). */
  readonly name: string;
  /** `join(parent.path, name)`. Never a path read from a row. */
  readonly path: string;
  readonly kind: 'file' | 'directory';
  /** The parent's guards; checked again in the removal step. */
  readonly guards: readonly string[];
}

export type OrphanListing =
  | { readonly status: 'listed'; readonly candidates: readonly OrphanCandidate[] }
  // readdir failed: one warning; the caller skips this sweep.
  | { readonly status: 'unreadable' };

/**
 * Direct children of `parent` that readdir reports as `kind` (Dirent types use lstat semantics, so
 * a symlink is never a file or directory candidate) and whose name passes `accept`.
 */
export const listOrphanCandidates = Effect.fnUntraced(function* (
  parent: GuardedDirectory,
  kind: 'file' | 'directory',
  accept: (name: string) => boolean,
  label: string,
) {
  let entries;
  try {
    entries = readdirSync(parent.path, { withFileTypes: true });
  } catch (error) {
    yield* Effect.logWarning('Could not list orphan collection entries').pipe(
      Effect.annotateLogs({
        collector: label,
        path: parent.path,
        cause: describeOperationalCause(error),
      }),
    );
    const unreadable: OrphanListing = { status: 'unreadable' };
    return unreadable;
  }
  const candidates = entries
    .filter((entry) => (kind === 'file' ? entry.isFile() : entry.isDirectory()))
    .filter((entry) => accept(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map(
      (name) =>
        ({
          name,
          path: join(parent.path, name),
          kind,
          guards: parent.guards,
        }) satisfies OrphanCandidate,
    );
  const listing: OrphanListing = { status: 'listed', candidates };
  return listing;
});

/** Canonical positive integer names, such as row ids: `'7'`, never `'07'`, `'1e3'` or `'1.5'`. */
export function isIdName(name: string): boolean {
  const value = Number(name);
  return Number.isSafeInteger(value) && value > 0 && String(value) === name;
}

/**
 * Newest mtimeMs of `path` and, for a directory, of its direct children. lstat only, so links are
 * never followed. Throws when `path` itself is missing; children that vanish meanwhile are skipped.
 */
export function lastWriteMs(path: string): number {
  const stat = lstatSync(path);
  let newest = stat.mtimeMs;
  if (!stat.isDirectory()) return newest;
  for (const name of readdirSync(path)) {
    try {
      newest = Math.max(newest, lstatSync(join(path, name)).mtimeMs);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
  }
  return newest;
}

export interface OrphanSweepStats {
  readonly inspected: number;
  readonly deleted: readonly string[];
  /** Live at decision time. */
  readonly kept: number;
  readonly skippedYoung: readonly string[];
  /** A guard or the entry itself is no longer a real directory or file. */
  readonly skippedUnsafe: readonly string[];
  readonly failed: readonly string[];
}

export const emptyOrphanSweepStats: OrphanSweepStats = {
  inspected: 0,
  deleted: [],
  kept: 0,
  skippedYoung: [],
  skippedUnsafe: [],
  failed: [],
};

/**
 * Decides and removes each candidate in one synchronous step, in this order:
 * live → kept; a guard is not a real directory → skippedUnsafe; entry missing →
 * ignored; entry not a real `kind` → skippedUnsafe; younger than `minAgeMs` →
 * skippedYoung; else removed → deleted. Any throw in the step becomes `failed`.
 * `nowMs` is fixed for the sweep, so anything touched after it started is young.
 * The fiber yields between batches so a large sweep does not starve other work.
 * Never fails.
 */
export const sweepOrphans = Effect.fnUntraced(function* (input: {
  readonly label: string;
  readonly candidates: readonly OrphanCandidate[];
  readonly isLive: (candidate: OrphanCandidate) => boolean;
  readonly minAgeMs: number;
  readonly nowMs: number;
}) {
  const deleted: string[] = [];
  const skippedYoung: string[] = [];
  const skippedUnsafe: string[] = [];
  const failed: string[] = [];
  let kept = 0;

  for (const [index, candidate] of input.candidates.entries()) {
    if (index > 0 && index % sweepBatchSize === 0) yield* Effect.yieldNow;
    const outcome = sweepCandidateSafely(candidate, input);
    if (outcome === 'kept') kept += 1;
    else if (outcome === 'deleted') deleted.push(candidate.name);
    else if (outcome === 'young') skippedYoung.push(candidate.name);
    else if (outcome === 'unsafe') skippedUnsafe.push(candidate.name);
    else if (outcome !== 'missing') {
      failed.push(candidate.name);
      yield* Effect.logWarning('Could not clean an orphan entry').pipe(
        Effect.annotateLogs({
          collector: input.label,
          name: candidate.name,
          cause: describeOperationalCause(outcome.error),
        }),
      );
    }
  }

  const stats: OrphanSweepStats = {
    inspected: input.candidates.length,
    deleted,
    kept,
    skippedYoung,
    skippedUnsafe,
    failed,
  };
  yield* logSweepSummary(input.label, stats);
  return stats;
});

function sweepCandidateSafely(
  candidate: OrphanCandidate,
  input: Parameters<typeof sweepCandidate>[1],
): ReturnType<typeof sweepCandidate> | { readonly error: unknown } {
  try {
    return sweepCandidate(candidate, input);
  } catch (error) {
    return { error };
  }
}

// Synchronous by contract (see the module comment): no `yield*` or `await` may be added here.
function sweepCandidate(
  candidate: OrphanCandidate,
  input: {
    readonly isLive: (candidate: OrphanCandidate) => boolean;
    readonly minAgeMs: number;
    readonly nowMs: number;
  },
): 'kept' | 'deleted' | 'young' | 'unsafe' | 'missing' {
  if (input.isLive(candidate)) return 'kept';
  if (!candidate.guards.every(isGuardIntact)) return 'unsafe';

  let stat;
  try {
    stat = lstatSync(candidate.path);
  } catch (error) {
    if (isMissingFileError(error)) return 'missing';
    throw error;
  }
  const expectedKind = candidate.kind === 'file' ? stat.isFile() : stat.isDirectory();
  if (stat.isSymbolicLink() || !expectedKind) return 'unsafe';

  if (input.nowMs - lastWriteMs(candidate.path) < input.minAgeMs) return 'young';

  if (candidate.kind === 'file') unlinkSync(candidate.path);
  else rmSync(candidate.path, { recursive: true, force: true });
  return 'deleted';
}

function isGuardIntact(path: string) {
  try {
    return isRealDirectory(path);
  } catch {
    return false;
  }
}

function isRealDirectory(path: string) {
  const stat = lstatSync(path);
  return stat.isDirectory() && !stat.isSymbolicLink();
}

function logSweepSummary(label: string, stats: OrphanSweepStats) {
  return Effect.gen(function* () {
    if (stats.deleted.length > 0) {
      yield* Effect.logInfo('Deleted orphan entries').pipe(
        Effect.annotateLogs({
          collector: label,
          count: stats.deleted.length,
          sample: sample(stats.deleted),
        }),
      );
    }
    if (stats.failed.length > 0) {
      yield* Effect.logWarning('Failed to clean orphan entries').pipe(
        Effect.annotateLogs({
          collector: label,
          count: stats.failed.length,
          sample: sample(stats.failed),
        }),
      );
    }
    if (stats.skippedUnsafe.length > 0) {
      yield* Effect.logWarning(
        'Skipped orphan entries reached through a link or of the wrong type',
      ).pipe(
        Effect.annotateLogs({
          collector: label,
          count: stats.skippedUnsafe.length,
          sample: sample(stats.skippedUnsafe),
        }),
      );
    }
  });
}

function sample(names: readonly string[]) {
  const suffix = names.length > summarySampleSize ? ', ...' : '';
  return `${names.slice(0, summarySampleSize).join(', ')}${suffix}`;
}

function isMissingFileError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  );
}
