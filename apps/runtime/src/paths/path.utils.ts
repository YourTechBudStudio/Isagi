import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';

// `home` is injectable so callers that already resolved the runtime home once can
// thread it through instead of re-reading the environment, and so tests can exercise
// tilde behavior against a temporary home without mutating `process.env` in a suite
// that runs with test isolation disabled. The default preserves every existing call.
function expandHomePath(input: string, home: string = homedir()): string {
  if (input === '~') {
    return home;
  }
  if (input.startsWith('~/')) {
    return resolve(home, input.slice(2));
  }
  return input;
}

export function normalizeHomePath(input: string, home: string = homedir()): string {
  const expanded = expandHomePath(input, home);
  if (expanded !== input) return expanded;
  return resolve(input);
}

export function normalizeAbsoluteHomePath(input: string): string {
  if (input.trim().length === 0)
    throw new Error(`Path must not be empty: ${JSON.stringify(input)}.`);

  const expanded = expandHomePath(input);

  if (!isAbsolute(expanded)) {
    throw new Error(
      `Path must be absolute or use ~ for the current user home directory: ${JSON.stringify(input)}.`,
    );
  }

  return normalize(expanded);
}

/**
 * The spelling the filesystem, and therefore Git, gives a path that may not exist yet: the real path
 * of its nearest existing ancestor, followed by the segments that do not exist.
 *
 * Two choices here are load-bearing for comparing a path with what Git reports or with another path
 * canonicalized the same way:
 *
 * - The nearest *existing* ancestor is resolved, not the path itself. A destination that is still to
 *   be created therefore still has its symlinked parents resolved, so macOS `/tmp/x` becomes
 *   `/private/tmp/x`, matching what `git worktree list` later reports.
 * - The ancestor is resolved with the native `realpath`, which returns the letter case stored on
 *   disk. The JS `realpathSync` keeps the case as typed, so on a case-insensitive disk two spellings
 *   of one folder would otherwise compare as different paths.
 *
 * Only "does not exist" (`ENOENT`) moves the search up a level. Any other failure, such as a denied
 * permission, is thrown, because the caller cannot know what the path refers to.
 */
export function canonicalizeProspectivePath(path: string): string {
  const missing: string[] = [];
  let candidate = resolve(path);
  for (;;) {
    try {
      return join(realpathSync.native(candidate), ...missing.reverse());
    } catch (error) {
      const parent = dirname(candidate);
      if (!isNotFound(error) || parent === candidate) throw error;
      missing.push(basename(candidate));
      candidate = parent;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  );
}
