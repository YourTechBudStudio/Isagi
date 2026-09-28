import { Effect } from 'effect';

import { apiEndpoints } from '@isagi/contracts';

import { CliContext, type CliIo } from '../context.js';
import { CliFailure } from '../errors.js';
import { canonicalizeProspectivePath, canonicalOrAsStored, isSameOrInside } from '../paths.js';
import { call, type RuntimeApiService } from '../runtime-api.js';

/** The worktree and surface a launch or a workflow listing is made from. */
export interface LaunchOrigin {
  readonly worktreeId: number;
  /** Null when the origin worktree has no surface to launch from. */
  readonly surfaceId: number | null;
}

/**
 * The launch origin: `--worktree` (with `--surface` when given) when passed; otherwise the worktree
 * whose path is the current directory or its longest prefix at a separator boundary, plus *that
 * worktree's currently focused surface*, or no surface when none is focused.
 *
 * The focused surface comes from worktree focus in the workspace snapshot, not from the calling
 * process, so it may be some other surface than the caller's own. Callers always echo the origin,
 * and the skill says when to pass the flags instead.
 */
export function resolveOrigin(flags: {
  readonly worktree: number | undefined;
  readonly surface: number | undefined;
}): Effect.Effect<LaunchOrigin, CliFailure, RuntimeApiService | CliIo> {
  return Effect.gen(function* () {
    if (flags.worktree !== undefined) {
      return { worktreeId: flags.worktree, surfaceId: flags.surface ?? null };
    }
    const io = yield* CliContext;
    const cwd = yield* Effect.try({
      try: () => canonicalizeProspectivePath(io.cwd),
      catch: () =>
        CliFailure.of(
          'origin_unresolved',
          `The current directory ${io.cwd} cannot be resolved; pass --worktree.`,
          { cwd: io.cwd },
        ),
    });
    const snapshot = yield* call(apiEndpoints.workspace.get);

    let match: { readonly id: number; readonly activeSurfaceId: number | null } | undefined;
    let matchLength = -1;
    for (const project of snapshot.projects) {
      for (const worktree of project.worktrees) {
        const path = canonicalOrAsStored(worktree.path);
        if (isSameOrInside(cwd, path) && path.length > matchLength) {
          match = worktree;
          matchLength = path.length;
        }
      }
    }
    if (match === undefined) {
      return yield* Effect.fail(
        CliFailure.of(
          'origin_unresolved',
          `${cwd} is not inside any worktree Isagi knows; pass --worktree.`,
          { cwd },
        ),
      );
    }
    return { worktreeId: match.id, surfaceId: match.activeSurfaceId };
  });
}
