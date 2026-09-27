# Choose a workflow environment

Use the optional `environment(ctx, inputs)` hook to choose the workflow's destination worktree and surface. The origin records where it was launched. Without a caller override or hook, destination is current/current as captured at launch; switching the UI does not retarget it. Consult the installed SDK's `launch.d.ts` for types.

## Placement

Both axes are required:

| Axis | Choices |
| --- | --- |
| Worktree | `{ kind: 'current' }`, `{ kind: 'existing', worktreeId }`, `{ kind: 'create', branch, fromRef }` |
| Surface | `{ kind: 'current' }`, `{ kind: 'existing', surfaceId }`, `{ kind: 'create', title }` |

Existing resources must belong to the launch project, and the surface must belong to the selected worktree and be free of an attached run. A new worktree requires a new surface. Folder projects support reuse and surface creation, but cannot create Git worktrees.

Creation requires a new branch name and resolvable `fromRef`; the resolved commit is fixed before preparation. A branch collision fails rather than implying reuse. Select existing resources by ID; surface titles are labels and duplicates receive a numeric suffix.

## Selection hook

The context exposes `origin`, `project: { id, name, kind }`, `listWorktrees()`, and `listSurfaces({ worktreeId })`. Await discovery inside the hook, then return a placement. Reads can lag the filesystem and do not reserve resources; preparation validates the selection. Keep the hook to discovery and deterministic computation. Perform agent work in graph operations.

This example assumes `validate` checks that `ticket` is a positive integer string:

```ts
import type {
  WorkflowEnvironmentContext,
  WorkflowPlacementRequest,
} from '@yourtechbudstudio/isagi-workflow-sdk';

export function environment(
  ctx: WorkflowEnvironmentContext,
  inputs: { readonly ticket: string },
): WorkflowPlacementRequest {
  const title = `Ticket ${inputs.ticket}`;
  return {
    worktree: ctx.project.kind === 'folder'
      ? { kind: 'current' }
      : { kind: 'create', branch: `ticket-${inputs.ticket}`, fromRef: 'HEAD' },
    surface: { kind: 'create', title },
  };
}
```

A second launch with that ticket requests another creation and can collide. To reuse a worktree, discover it and return `existing` explicitly.

## Ordering and overrides

Precedence is caller `placement`, then `environment`, then current/current. A caller override skips the selector, while input and placement validation still run. The order is `command → validate → selection → prepare → init`. Root `init(destination, parameters)` runs after preparation; initialized frames are not initialized again on Retry. Subgraphs inherit the root destination.

Inspect `preparation.source`, `preparation.request`, and `destination` to distinguish requested and effective placement. A returned run ID alone does not prove preparation succeeded: check `preparation.status` and failure details.

## Failed preparation

Retry reuses the recorded placement and base commit. Editing `environment` does not relocate that run. Created resources remain after failure or cancellation; inspect the preparation receipts before acting. Setup may repeat unless already succeeded or skipped, so hooks must tolerate partial prior execution. See [Project config](config-project.md) for setup and trust.

Resolve trust, occupancy, or collision failures before Retry. Missing worktrees/surfaces, a surface on the wrong worktree, or a deleted origin may require a fresh launch with valid placement. Pause and Resume are unavailable during preparation; interrupted preparation fails on restart and uses Retry for recovery. Cancel does not roll back resources or stop an in-flight setup hook.

For recovery after graph execution begins, read [Workflow recovery](workflow-recovery.md).
