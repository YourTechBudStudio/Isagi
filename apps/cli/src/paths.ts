import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

/**
 * The canonical form of a path that may not exist yet: the native realpath of its nearest existing
 * ancestor, with the missing segments appended.
 *
 * This must match `canonicalizeProspectivePath` in `apps/runtime/src/paths/path.utils.ts` exactly.
 * The CLI checks an export destination with this rule before asking the runtime to create a
 * worktree there, and then requires the runtime to report the very same path back; if the two
 * derivations drifted, a correct export would fail, or a precheck would judge a different path than
 * the one written. It is duplicated rather than shared because the CLI never imports runtime code.
 *
 * Native realpath is used because it returns the on-disk letter case (`realpathSync` keeps the typed
 * case), so the same folder typed two ways compares equal on a case-insensitive disk. Only "does
 * not exist" walks up a level; any other failure is thrown, because the caller cannot know what the
 * path refers to.
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

/**
 * A known checkout path in the same canonical form as a destination. A path that cannot be resolved
 * (for example a checkout whose folder is gone) is compared as stored, as the runtime does.
 */
export function canonicalOrAsStored(path: string): string {
  try {
    return canonicalizeProspectivePath(path);
  } catch {
    return path;
  }
}

/** Whether `path` is `root` itself or lies beneath it, at a separator boundary. */
export function isSameOrInside(path: string, root: string): boolean {
  if (path === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return path.startsWith(prefix);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  );
}
