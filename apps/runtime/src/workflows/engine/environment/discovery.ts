import { Effect } from 'effect';

import type { SurfaceService } from '../../../environment/index.js';
import type { ProjectRepository } from '../../../projects/index.js';
import { WorkflowOperationFailed } from '../../errors.js';
import type {
  WorkflowOrigin,
  WorkflowPlacementContext,
  WorkflowSurfaceSummary,
  WorkflowWorktreeSummary,
} from '../../types.js';
import type { AuthorBridge } from '../author-bridge.js';
import type { LaunchProject } from './types.js';

export interface DiscoveryDeps {
  readonly workspace: Pick<ProjectRepository['Service'], 'listWorktrees' | 'findWorktree'>;
  readonly surfaceReads: Pick<SurfaceService['Service'], 'listWorkspaceSurfaceMetadata'>;
  readonly bridge: AuthorBridge;
}

/**
 * What the author's `placement` hook may read while choosing where a run is placed.
 *
 * Three properties define it, and each is load-bearing:
 *
 * **Project-scoped.** Only the launch project's worktrees, and only surfaces on a worktree of that
 * project. A hook cannot enumerate, let alone target, somebody else's project.
 *
 * **Not a reservation.** Rows are returned as recorded, with no reconciliation against Git or the
 * filesystem — ADR 0001 keeps reconciliation out of ordinary reads and ADR 0002 keeps discovery and
 * repair on explicit requests. A listed worktree may already be gone. That is acceptable precisely
 * because nothing here holds anything: every choice is statically validated at launch and re-checked
 * per step during preparation.
 *
 * **Closed when the hook returns.** A context retained past `placement()` would let author code
 * read rows at an arbitrary later moment, outside the launch it belongs to, which is neither
 * meaningful nor something the launch can account for. Every call after `close()` rejects, the same
 * posture `operation_context_closed` takes for operation contexts.
 *
 * There is deliberately no timeout and no sandbox. `command` and `parse` have neither, adding one
 * only here would be inconsistent, and the loader cannot enforce that author code performs no IO of
 * its own. The achievable guarantee is a narrow context plus documentation, and the shipped skill
 * reference says so.
 */
export function makePlacementContext(
  deps: DiscoveryDeps,
  input: { readonly origin: WorkflowOrigin; readonly project: LaunchProject },
): { readonly context: WorkflowPlacementContext; readonly close: () => void } {
  /**
   * The bridge author code sees.
   *
   * Promise-shaped for the same reason `command` and `parse` are: the SDK surface is Tier 0
   * plain TypeScript and no Effect concept crosses it.
   */
  const bridge = deps.bridge.open('The placement context is closed once placement() has returned.');

  const context: WorkflowPlacementContext = {
    origin: input.origin,
    project: { id: input.project.id, name: input.project.name, kind: input.project.kind },
    listWorktrees: () =>
      bridge.run(
        deps.workspace.listWorktrees.pipe(
          Effect.map((rows) =>
            rows
              .filter((row) => row.projectId === input.project.id)
              .map((row): WorkflowWorktreeSummary => ({
                id: row.id,
                path: row.path,
                branch: row.branch,
                head: row.head,
                // The same rule `workspace.snapshot.ts` applies: the root worktree is the one
                // checked out at the project root, not a flag on the row.
                isRoot: row.path === input.project.rootPath,
              })),
          ),
        ),
      ),
    listSurfaces: ({ worktreeId }) =>
      bridge.run(
        Effect.gen(function* () {
          const worktree = yield* deps.workspace.findWorktree(worktreeId);
          if (!worktree || worktree.projectId !== input.project.id) {
            return yield* new WorkflowOperationFailed({
              message: `Worktree ${worktreeId} is not in this project.`,
            });
          }
          const surfaces = yield* deps.surfaceReads.listWorkspaceSurfaceMetadata;
          return surfaces
            .filter((row) => row.worktreeId === worktreeId)
            .map((row): WorkflowSurfaceSummary => ({
              id: row.id,
              worktreeId: row.worktreeId,
              title: row.title,
            }));
        }),
      ),
  };

  return { context, close: bridge.close };
}
