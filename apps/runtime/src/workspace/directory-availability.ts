import { statSync } from 'node:fs';

import { isPermissionError } from '../lib/fs-errors.js';

export type DirectoryAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

/**
 * Presence with a diagnosable cause, shared by both reconciliation branches, by
 * `ensureProjectPathAvailable` and by detached worktree creation's read-only
 * preflight, so none of them can describe the same folder differently. "Not
 * there", "not a folder any more" and "could not be read" are different answers,
 * only some of them are the user's to fix, and the string lands verbatim on the
 * missing-project canvas.
 *
 * A successful stat establishes that something is there and that it is a
 * directory. It does not establish that the directory can be listed, that Git
 * can work inside it, or that it is the same physical directory as yesterday —
 * `stat` follows symlinks, exactly as the `pathIsDirectory` it replaces did.
 */
export function directoryAvailability(path: string): DirectoryAvailability {
  try {
    return statSync(path).isDirectory()
      ? { available: true }
      : { available: false, reason: `Project path is no longer a folder: ${path}` };
  } catch (error) {
    if (isPermissionError(error)) {
      return { available: false, reason: `Isagi cannot read the project folder: ${path}` };
    }
    return { available: false, reason: `Project path not found: ${path}` };
  }
}
