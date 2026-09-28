import { lstatSync, readdirSync } from 'node:fs';
import { isAbsolute, sep } from 'node:path';

import { Data, Effect } from 'effect';

import type { WorktreeDestinationIssue } from '@isagi/contracts';

import { canonicalizeProspectivePath } from '../paths/index.js';
import type { DatabaseError } from '../persistence/index.js';
import type { WorkspaceRepositoryService } from './workspace.repository.js';

/**
 * Whether a caller-chosen path can become a new directory Isagi creates: a detached worktree, or a
 * checkpoint export's plain folder. One rule for both, so they cannot disagree about a folder.
 */
export class NewDirectoryRejected extends Data.TaggedError('NewDirectoryRejected')<{
  readonly issue: WorktreeDestinationIssue;
  readonly message: string;
  /** Canonical once the check got that far, otherwise as given. */
  readonly path: string;
  /** The containing worktree row, for `inside_checkout` when Isagi knows it. */
  readonly containingWorktreeId?: number | undefined;
}> {}

/**
 * Read-only. Returns the canonical path when it is absolute, absent or an empty directory, and not
 * equal to or inside any checkout: every worktree and project root Isagi knows, across all projects
 * whatever their status, plus `extraCheckouts` (for example what Git lists for a repository but
 * Isagi has not reconciled yet). Both sides are canonicalized the same way, so letter case and
 * symlinked parents cannot hide a match. The path as given is inspected before it is resolved, so a
 * symlink is refused, not followed.
 */
export function checkNewDirectory(
  repository: Pick<WorkspaceRepositoryService, 'listProjects' | 'listWorktrees'>,
  path: string,
  extraCheckouts: readonly string[] = [],
): Effect.Effect<string, NewDirectoryRejected | DatabaseError> {
  return Effect.gen(function* () {
    const rejected = (issue: WorktreeDestinationIssue, message: string, at = path) =>
      Effect.fail(new NewDirectoryRejected({ issue, message, path: at }));

    if (!isAbsolute(path)) {
      return yield* rejected('not_absolute', `Destination must be an absolute path: ${path}`);
    }
    switch (inspect(path)) {
      case 'absent':
      case 'empty_directory':
        break;
      case 'not_directory':
        return yield* rejected('not_directory', `Destination is not a directory: ${path}`);
      case 'not_empty':
        return yield* rejected('not_empty', `Destination is not empty: ${path}`);
      case 'inaccessible':
        return yield* rejected('inaccessible', `Destination cannot be inspected: ${path}`);
    }

    let destination: string;
    try {
      destination = canonicalizeProspectivePath(path);
    } catch {
      return yield* rejected('inaccessible', `Destination cannot be resolved: ${path}`);
    }

    const projects = yield* repository.listProjects;
    const worktrees = yield* repository.listWorktrees;
    const checkouts: readonly { readonly path: string; readonly worktreeId?: number }[] = [
      ...worktrees.map((worktree) => ({ path: worktree.path, worktreeId: worktree.id })),
      ...projects.map((project) => ({ path: project.rootPath })),
      ...extraCheckouts.map((extra) => ({ path: extra })),
    ];
    for (const checkout of checkouts) {
      const checkoutPath = canonicalOrAsStored(checkout.path);
      const prefix = checkoutPath.endsWith(sep) ? checkoutPath : checkoutPath + sep;
      if (destination === checkoutPath || destination.startsWith(prefix)) {
        return yield* Effect.fail(
          new NewDirectoryRejected({
            issue: 'inside_checkout',
            message: `Destination ${destination} is inside the checkout at ${checkout.path}.`,
            path: destination,
            containingWorktreeId: checkout.worktreeId,
          }),
        );
      }
    }
    return destination;
  });
}

type DestinationState =
  | 'absent'
  | 'empty_directory'
  | 'not_empty'
  | 'not_directory'
  | 'inaccessible';

function inspect(path: string): DestinationState {
  try {
    const stats = lstatSync(path);
    if (!stats.isDirectory()) return 'not_directory';
    return readdirSync(path).length === 0 ? 'empty_directory' : 'not_empty';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'inaccessible';
  }
}

/** A checkout that cannot be resolved is compared by the spelling Isagi or Git recorded for it. */
function canonicalOrAsStored(path: string) {
  try {
    return canonicalizeProspectivePath(path);
  } catch {
    return path;
  }
}
