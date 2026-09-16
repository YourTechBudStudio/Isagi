import { Effect } from 'effect';

import type { InternalRuntimeEventBusService } from '../../runtime-events/internal-event-bus.js';
import type { SurfaceRepositoryService } from '../../surfaces/surfaces.repository.js';
import type { WorkspaceRepositoryService } from '../../workspace/workspace.repository.js';
import type { WorkflowRunRecord } from '../persistence/records.js';
import type { WorkflowRunsRepositoryService } from '../persistence/runs.repository.js';

/**
 * Keeping placement honest when the environment underneath a run disappears.
 *
 * Affected runs are found through **retained destination identity** — plain columns with no foreign
 * key — and never through the attachment. Every deletion notification in this codebase is published
 * *after* the delete commits, so by the time a handler runs the attachment has already been nulled
 * or removed by the cascade: asking "which runs are attached to that surface?" would find nothing,
 * every time, and the bug would look like a missed event rather than a wrong query.
 *
 * `environment_available` is a **cache**, never the authority. A dropped notification therefore
 * costs one rejected claim — the claim re-checks live placement itself — rather than a callback
 * running against a worktree that is gone.
 */
export interface EnvironmentWatchDeps {
  readonly runs: WorkflowRunsRepositoryService;
  readonly workspace: WorkspaceRepositoryService;
  /** Read composition over the surface owner's rows; this module never writes them (ADR 0008). */
  readonly surfaces: Pick<SurfaceRepositoryService, 'findSurface'>;
  readonly eventBus: InternalRuntimeEventBusService;
}

export function startEnvironmentWatch(deps: EnvironmentWatchDeps) {
  return Effect.gen(function* () {
    const subscription = yield* deps.eventBus.subscribe({
      types: ['surface_changed', 'worktree_deleted', 'project_deleted'],
    });
    yield* Effect.addFinalizer(() => subscription.unsubscribe);
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const event = yield* subscription.take;
          if (event.type === 'surface_changed') {
            if (event.payload.change !== 'deleted') return;
            yield* parkRuns(
              deps,
              yield* deps.runs.listByDestinationSurface(event.payload.surfaceId),
            );
            return;
          }
          if (event.type === 'worktree_deleted') {
            yield* parkRuns(deps, yield* deps.runs.listByDestinationWorktree(event.worktreeId));
            return;
          }
          if (event.type === 'project_deleted') {
            yield* parkRuns(deps, yield* deps.runs.listByDestinationWorktrees(event.worktreeIds));
          }
        }).pipe(
          Effect.catchAllCause((cause) =>
            Effect.sync(() => {
              console.warn('[runtime] Workflow environment lifecycle handling failed', cause);
            }),
          ),
        ),
      ),
    );
  });
}

/**
 * Re-derives placement for every non-terminal run, at startup.
 *
 * Matched by destination identity rather than by the attachment, which is what finds a run whose
 * attachment cascaded away while the process was down — including through a project deletion nobody
 * was listening for.
 */
export function rederiveEnvironments(deps: EnvironmentWatchDeps) {
  return Effect.gen(function* () {
    const runs = yield* deps.runs.listNonTerminal();
    const unavailable: WorkflowRunRecord[] = [];
    for (const run of runs) {
      const live = yield* placementIsLive(deps, run);
      if (live === run.environmentAvailable) continue;
      yield* deps.runs.setEnvironmentAvailable({ runId: run.id, available: live });
      if (!live) unavailable.push(run);
    }
    // Parked as a separate step, so a run that was already parked is not parked again and the
    // waterfall does not gain a second band for one absence.
    yield* parkRuns(deps, unavailable);
    return unavailable.length;
  });
}

function placementIsLive(deps: EnvironmentWatchDeps, run: WorkflowRunRecord) {
  return Effect.gen(function* () {
    const { worktreeId, surfaceId } = run.destination;
    if (worktreeId === null) return false;
    const worktree = yield* deps.workspace.findWorktree(worktreeId);
    if (!worktree) return false;
    if (surfaceId === null) return true;
    const surface = yield* deps.surfaces.findSurface(surfaceId);
    return surface !== null && surface.worktreeId === worktreeId;
  });
}

function parkRuns(deps: EnvironmentWatchDeps, runs: readonly WorkflowRunRecord[]) {
  const runIds = runs.filter((run) => !run.paused || run.environmentAvailable).map((run) => run.id);
  if (runIds.length === 0) return Effect.void;
  return deps.runs
    .parkEnvironmentDeleted({
      runIds,
      detail: { value: { control: 'environment_deleted' } },
    })
    .pipe(Effect.asVoid);
}
