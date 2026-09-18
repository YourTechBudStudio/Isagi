import { Effect } from 'effect';

import type { SurfaceRepositoryService } from '../../../surfaces/index.js';
import type { WorkspaceRepositoryService } from '../../../workspace/workspace.repository.js';
import type {
  WorkflowEnvironmentContext,
  WorkflowOrigin,
  WorkflowSurfaceSummary,
  WorkflowWorktreeSummary,
} from '../../types.js';
import type { LaunchProject } from './types.js';

export interface DiscoveryDeps {
  readonly workspace: Pick<WorkspaceRepositoryService, 'listWorktrees' | 'findWorktree'>;
  readonly surfaceRepository: Pick<SurfaceRepositoryService, 'listWorkspaceSurfaceMetadata'>;
}

/**
 * What the author's `environment` hook may read while choosing where a run is placed.
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
 * **Closed when the hook returns.** A context retained past `environment()` would let author code
 * read rows at an arbitrary later moment, outside the launch it belongs to, which is neither
 * meaningful nor something the launch can account for. Every call after `close()` rejects, the same
 * posture `operation_context_closed` takes for operation contexts.
 *
 * There is deliberately no timeout and no sandbox. `command` and `validate` have neither, adding one
 * only here would be inconsistent, and the loader cannot enforce that author code performs no IO of
 * its own. The achievable guarantee is a narrow context plus documentation, and the shipped skill
 * reference says so.
 */
export function makeEnvironmentContext(
  deps: DiscoveryDeps,
  input: { readonly origin: WorkflowOrigin; readonly project: LaunchProject },
): { readonly context: WorkflowEnvironmentContext; readonly close: () => void } {
  let closed = false;

  /**
   * The bridge author code sees.
   *
   * Promise-shaped for the same reason `command` and `validate` are: the SDK surface is Tier 0
   * plain TypeScript and no Effect concept crosses it.
   */
  const bridge = <A>(effect: Effect.Effect<A, unknown>): Promise<A> => {
    if (closed) {
      return Promise.reject(
        new Error('The environment context is closed once environment() has returned.'),
      );
    }
    return Effect.runPromise(effect as Effect.Effect<A, unknown, never>);
  };

  const context: WorkflowEnvironmentContext = {
    origin: input.origin,
    project: { id: input.project.id, name: input.project.name, kind: input.project.kind },
    listWorktrees: () =>
      bridge(
        deps.workspace.listWorktrees.pipe(
          Effect.map((rows) =>
            rows
              .filter((row) => row.projectId === input.project.id)
              .map(
                (row): WorkflowWorktreeSummary => ({
                  id: row.id,
                  path: row.path,
                  branch: row.branch,
                  head: row.head,
                  // The same rule `workspace.snapshot.ts` applies: the root worktree is the one
                  // checked out at the project root, not a flag on the row.
                  isRoot: row.path === input.project.rootPath,
                }),
              ),
          ),
        ),
      ),
    listSurfaces: ({ worktreeId }) =>
      bridge(
        Effect.gen(function* () {
          const worktree = yield* deps.workspace.findWorktree(worktreeId);
          if (!worktree || worktree.projectId !== input.project.id) {
            return yield* Effect.fail(new Error(`Worktree ${worktreeId} is not in this project.`));
          }
          const surfaces = yield* deps.surfaceRepository.listWorkspaceSurfaceMetadata;
          return surfaces
            .filter((row) => row.worktreeId === worktreeId)
            .map(
              (row): WorkflowSurfaceSummary => ({
                id: row.id,
                worktreeId: row.worktreeId,
                title: row.title,
              }),
            );
        }),
      ),
  };

  return { context, close: () => void (closed = true) };
}
