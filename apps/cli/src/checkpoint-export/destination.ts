import { lstat, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Effect } from 'effect';

import { apiEndpoints, type WorktreeDestinationIssue } from '@isagi/contracts';

import { CliFailure, errnoOf } from '../errors.js';
import { canonicalizeProspectivePath, canonicalOrAsStored, isSameOrInside } from '../paths.js';
import { call, type RuntimeApiService } from '../runtime-api.js';

/**
 * `resolve_destination`: where the export goes, and proof that it may go there.
 *
 * The destination must be absent or an empty real directory (never a symlink, which would be
 * followed), and must not be, or lie inside, any checkout: the run's own source worktree whatever
 * its project's status (from the run's recorded destination), any project root, and any worktree
 * the workspace snapshot lists. For a Git export the runtime checks again with its own rule; for a
 * directory-only export this is the only check. A linked worktree of a *different* missing project
 * is not listed by the snapshot, so it cannot be seen here; that limit is documented.
 *
 * Nothing is written. The result is the canonical path, derived exactly as the runtime derives it.
 */
export function resolveDestination(input: {
  readonly runId: number;
  readonly output: string;
  readonly cwd: string;
}): Effect.Effect<string, CliFailure, RuntimeApiService> {
  return Effect.gen(function* () {
    const requested = resolve(input.cwd, input.output);
    const rejected = (issue: WorktreeDestinationIssue, message: string, extra: object = {}) =>
      Effect.fail(
        CliFailure.of('export_destination_rejected', message, {
          destinationPath: requested,
          destinationIssue: issue,
          ...extra,
        }),
      );

    const state = yield* Effect.promise(() => inspect(requested));
    switch (state.kind) {
      case 'absent':
      case 'empty_directory':
        break;
      case 'not_directory':
        return yield* rejected(
          'not_directory',
          `${requested} exists and is not a directory (a symlink is never followed).`,
        );
      case 'not_empty':
        return yield* rejected('not_empty', `${requested} is not empty.`);
      case 'inaccessible':
        return yield* rejected('inaccessible', `${requested} cannot be inspected.`, {
          errno: state.errno,
        });
    }

    const canonical = yield* Effect.try({
      try: () => canonicalizeProspectivePath(requested),
      catch: (cause) =>
        CliFailure.of('export_destination_rejected', `${requested} cannot be resolved.`, {
          destinationPath: requested,
          destinationIssue: 'inaccessible',
          errno: errnoOf(cause) ?? null,
        }),
    });
    const inside = (issue: string, checkoutPath: string, extra: object) =>
      Effect.fail(
        CliFailure.of(
          'export_destination_rejected',
          `${canonical} is inside the ${issue} at ${checkoutPath}; export somewhere outside every checkout.`,
          {
            destinationPath: canonical,
            destinationIssue: 'inside_checkout',
            checkoutPath,
            ...extra,
          },
        ),
      );

    const { run } = yield* call(apiEndpoints.workflows.getRun, { runId: input.runId });
    const sourcePath = run.destination.worktreePath;
    if (sourcePath === null) {
      // A run that saved a checkpoint had a prepared destination; a null one is not a state export
      // can reason about.
      return yield* Effect.fail(
        CliFailure.of(
          'runtime_response_invalid',
          `Run ${input.runId} has no recorded destination worktree path, so its source cannot be protected.`,
          { runId: input.runId },
        ),
      );
    }
    if (isSameOrInside(canonical, canonicalOrAsStored(sourcePath))) {
      return yield* inside('source worktree of this run', sourcePath, { sourceWorktree: true });
    }

    const snapshot = yield* call(apiEndpoints.workspace.get);
    for (const project of snapshot.projects) {
      for (const worktree of project.worktrees) {
        if (isSameOrInside(canonical, canonicalOrAsStored(worktree.path))) {
          return yield* inside('worktree', worktree.path, { worktreeId: worktree.id });
        }
      }
      if (isSameOrInside(canonical, canonicalOrAsStored(project.rootPath))) {
        return yield* inside('project root', project.rootPath, { projectId: project.id });
      }
    }
    return canonical;
  });
}

type DestinationState =
  | { readonly kind: 'absent' | 'empty_directory' | 'not_directory' | 'not_empty' }
  | { readonly kind: 'inaccessible'; readonly errno: string | null };

async function inspect(path: string): Promise<DestinationState> {
  try {
    const stats = await lstat(path);
    if (!stats.isDirectory()) return { kind: 'not_directory' };
    return (await readdir(path)).length === 0 ? { kind: 'empty_directory' } : { kind: 'not_empty' };
  } catch (error) {
    const errno = errnoOf(error) ?? null;
    return errno === 'ENOENT' ? { kind: 'absent' } : { kind: 'inaccessible', errno };
  }
}
