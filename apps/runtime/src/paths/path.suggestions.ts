import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { Effect } from 'effect';

import { logDiagnosticEvent } from '../diagnostics/phase.js';
import { normalizeHomePath } from './path.utils.js';

export interface PathSuggestInput {
  readonly input: string;
  readonly limit?: number | undefined;
}

const DEFAULT_LIMIT = 25;
/** Entries examined between event-loop yields. */
const SCAN_CHUNK = 1_000;
/** Concurrent `stat` calls within one chunk. Per invocation, not runtime-wide. */
const RESOLUTION_CONCURRENCY = 8;

const collator = new Intl.Collator(undefined, { usage: 'sort' });

/**
 * The subset of `Dirent` the scan reads. Node's `Dirent` satisfies it structurally,
 * so tests can drive the selection seam with synthetic entries.
 */
export interface ScanDirent {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
}

/** `order` is the enumeration index, which is what makes the sort stable. */
interface Candidate {
  readonly name: string;
  readonly order: number;
}

// The enumeration-index tiebreak is load-bearing, not decoration. Distinct names can
// collate equal -- `Intl.Collator().compare('\u00e9', 'e\u0301') === 0` -- and both
// spellings can exist side by side on a filesystem that stores names as bytes.
// Candidates also reach the buffer out of enumeration order, because symlink and
// unknown-type entries are resolved after their chunk's directly-confirmed entries.
// Comparing on name alone would make the result depend on that resolution order.
function byName(a: Candidate, b: Candidate) {
  return collator.compare(a.name, b.name) || a.order - b.order;
}

/** A real event-loop turn, not a microtask: timers and IO callbacks get to run. */
const yieldToEventLoop = Effect.async<void>((resume) => {
  const handle = setImmediate(() => {
    resume(Effect.void);
  });
  return Effect.sync(() => {
    clearImmediate(handle);
  });
});

/**
 * Bounded selection over an already-enumerated directory, exported as the processing
 * seam so responsiveness can be observed without filesystem waits in the measurement.
 *
 * Returns the first `limit` entries of the stable name-sort of the confirmed
 * directories -- the same set, in the same order, as
 * `filter(isDirectory).sort(byName).slice(0, limit)`, for a fixed set of resolution
 * outcomes. `couldPlace` rejects a candidate only when the buffer already holds
 * `limit` confirmed directories that all sort before it, and the buffer's last
 * element only ever moves earlier in sort order, so a rejection never needs
 * revisiting. There is no scan cutoff: nothing readable and matching is dropped.
 *
 * Memory: the result buffer is bounded by `limit` and the pending set by
 * `SCAN_CHUNK`. The caller's `entries` array is still O(n).
 */
export function selectDirectorySuggestions(
  basePath: string,
  entries: readonly ScanDirent[],
  filter: string,
  limit: number,
) {
  return Effect.gen(function* () {
    const showHidden = filter.startsWith('.');
    const lowerFilter = filter.toLowerCase();
    // Sorted, length <= limit, confirmed directories only.
    const buffer: Candidate[] = [];

    for (let offset = 0; offset < entries.length; offset += SCAN_CHUNK) {
      const end = Math.min(offset + SCAN_CHUNK, entries.length);
      const pending: Candidate[] = [];

      for (let index = offset; index < end; index += 1) {
        const entry = entries[index]!;
        if (!matchesFilter(entry.name, lowerFilter, showHidden)) continue;
        const candidate = { name: entry.name, order: index };
        // Already beaten by `limit` confirmed directories: no insert, and no IO.
        if (!couldPlace(buffer, candidate, limit)) continue;
        if (entry.isDirectory()) insertBounded(buffer, candidate, limit);
        else if (needsResolution(entry)) pending.push(candidate);
        // A known non-directory is skipped with no `stat` at all.
      }

      if (pending.length > 0) {
        const resolved = yield* Effect.forEach(
          pending,
          (candidate) => isDirectoryPath(join(basePath, candidate.name)),
          { concurrency: RESOLUTION_CONCURRENCY },
        );
        pending.forEach((candidate, position) => {
          if (resolved[position]) insertBounded(buffer, candidate, limit);
        });
      }

      yield* yieldToEventLoop;
    }

    return buffer;
  });
}

export function suggestPathsAtHome(input: PathSuggestInput, home: string) {
  return Effect.gen(function* () {
    const parsed = parseInput(input.input, home);
    const limit = input.limit ?? DEFAULT_LIMIT;
    const entries = yield* listDirectoryEntries(parsed.basePath);
    const selected = yield* selectDirectorySuggestions(
      parsed.basePath,
      entries,
      parsed.filter,
      limit,
    );

    return {
      basePath: displayPath(parsed.basePath, home),
      input: input.input,
      suggestions: selected.map((candidate) => ({
        path: displayPath(join(parsed.basePath, candidate.name), home),
        label: candidate.name,
        kind: 'directory' as const,
        hidden: candidate.name.startsWith('.'),
      })),
    };
  });
}

// `Effect.suspend` so the runtime home is read when the effect executes, not when it
// is constructed. Composing rather than running keeps the request interrupt signal
// that `registerApiEndpoint` threads into `Effect.runPromise` effective.
export function suggestPaths(input: PathSuggestInput) {
  return Effect.suspend(() => suggestPathsAtHome(input, homedir()));
}

function parseInput(input: string, home: string) {
  const trimmed = input.trim();
  if (!trimmed) {
    return { basePath: home, filter: '' };
  }

  const expanded = trimmed.startsWith('~')
    ? normalizeHomePath(trimmed, home)
    : isAbsolute(trimmed)
      ? resolve(trimmed)
      : resolve(home, trimmed);

  if (trimmed.endsWith('/') || trimmed.endsWith(sep)) {
    return { basePath: expanded, filter: '' };
  }

  return { basePath: dirname(expanded), filter: basename(expanded) };
}

// A missing, unreadable, or non-directory base is an advisory empty listing, not a
// request failure: suggestion time never diagnoses a path, submission does. The cause
// would otherwise be discarded silently, so it is kept behind the existing debug gate.
function listDirectoryEntries(basePath: string) {
  return Effect.tryPromise({
    try: () => readdir(basePath, { withFileTypes: true }),
    catch: (error) => error,
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        logDiagnosticEvent(
          'paths.listing_failed',
          { basePath, reason: listingFailureReason(error) },
          'warn',
        );
        return [] as readonly ScanDirent[];
      }),
    ),
  );
}

// A bounded, meaningful reason: the filesystem error code where there is one. Never
// directory contents, and never an uncontrolled error-object dump.
function listingFailureReason(error: unknown) {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return error instanceof Error ? error.name : 'unknown';
}

// A candidate whose `stat` fails is simply not confirmed as a directory. It never
// fails the request, and it never occupies a slot a confirmed directory could use.
function isDirectoryPath(path: string) {
  return Effect.promise(() =>
    stat(path).then(
      (stats) => stats.isDirectory(),
      () => false,
    ),
  );
}

function matchesFilter(name: string, lowerFilter: string, showHidden: boolean) {
  if (!showHidden && name.startsWith('.')) return false;
  return name.toLowerCase().startsWith(lowerFilter);
}

function needsResolution(entry: ScanDirent) {
  return entry.isSymbolicLink() || isUnknownDirent(entry);
}

// Some filesystems report no `d_type`, leaving every predicate false.
function isUnknownDirent(entry: ScanDirent) {
  return (
    !entry.isDirectory() &&
    !entry.isFile() &&
    !entry.isSymbolicLink() &&
    !entry.isBlockDevice() &&
    !entry.isCharacterDevice() &&
    !entry.isFIFO() &&
    !entry.isSocket()
  );
}

function couldPlace(buffer: readonly Candidate[], candidate: Candidate, limit: number) {
  return buffer.length < limit || byName(candidate, buffer[limit - 1]!) < 0;
}

// Upper-bound insertion: placing after equal elements is what reproduces the stable
// sort's placement. The ordering guarantee itself comes from `byName`'s index
// tiebreak, so sorting the bounded buffer with the same comparator would also be
// correct; this just avoids re-sorting on every insert.
function insertBounded(buffer: Candidate[], candidate: Candidate, limit: number) {
  let low = 0;
  let high = buffer.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (byName(candidate, buffer[mid]!) < 0) high = mid;
    else low = mid + 1;
  }
  buffer.splice(low, 0, candidate);
  if (buffer.length > limit) buffer.length = limit;
}

// Home-rooted paths always render with the tilde, regardless of how the input was
// typed (absolute, relative, or already-tilde). One consistent display form. The
// comparison is lexical: removing home containment removed the only realpath check,
// and display was never canonicalized.
function displayPath(path: string, home: string) {
  if (path === home || path.startsWith(`${home}${sep}`)) {
    return path === home ? '~' : `~/${path.slice(home.length + 1)}`;
  }
  return path;
}
