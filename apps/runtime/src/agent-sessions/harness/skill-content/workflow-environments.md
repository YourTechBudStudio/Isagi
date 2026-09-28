# Choose a workflow environment

Use the optional `environment(ctx, inputs)` hook to choose the workflow's destination worktree and surface. The origin records where it was launched; its `surfaceId` is null when the worktree had no surface open. Without a caller override or hook, destination is current/current as captured at launch, or the current worktree plus a new surface titled after the command when the origin has no surface; switching the UI does not retarget it. Consult the installed SDK's `launch.d.ts` for types.

## Placement

Both axes are required:

| Axis | Choices |
| --- | --- |
| Worktree | `{ kind: 'current' }`, `{ kind: 'existing', worktreeId }`, `{ kind: 'create', branch, fromRef }` |
| Surface | `{ kind: 'current' }`, `{ kind: 'existing', surfaceId }`, `{ kind: 'create', title }` |

Existing resources must belong to the launch project, and the surface must belong to the selected worktree and be free of an attached run. A `current` surface is refused (`no_current_surface`) when the origin has none. A new worktree requires a new surface. Folder projects support reuse and surface creation, but cannot create Git worktrees.

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

Precedence is caller `placement`, then `environment`, then the default (current/current, or current worktree plus a new surface when the origin has no surface). A caller override skips the selector, while input and placement validation still run. The order is `command → validate → selection → prepare → init`. Root `init(destination, parameters)` runs after preparation; a graph invocation that already exists is not initialized again on Retry. Subgraphs inherit the root destination.

A run starts `preparing`. Its summary's `placement` holds what was requested (`request`), who decided it (`source`: `override`, `selector` or `default`), and the commit a new worktree's `fromRef` resolved to (`baseCommit`); `worktreeId`, `surfaceId` and `setupDone` hold what preparation has actually produced so far. A returned run ID alone does not prove preparation succeeded: a failure leaves the run `failed` with an error at stage `environment`.

Preparation runs these steps, saving each result on the run and appending an environment event as it finishes: create the worktree (`worktree_created`), run its setup hooks (`setup_finished` or `setup_failed`, with their output), create the surface (`surface_created`). A created surface starts empty; the first agent the run starts becomes its first pane. Closing a surface's last pane leaves the surface empty rather than deleting it, so a run keeps its surface after its agents close. A failure appends `preparation_failed`.

## Failed preparation

Retry runs preparation again and skips every step whose result is already saved, so it creates the worktree from the recorded base commit even if the ref has moved, and never creates a second one. Editing `environment` does not relocate that run. Created resources remain after failure or cancellation; the run's environment events say exactly what was created. Setup reruns until it succeeds, so hooks must tolerate partial prior execution. A `current` or `existing` surface that was deleted fails preparation again: a run never replaces a surface it did not create. See [Project config](config-project.md) for setup and trust.

Resolve trust, occupancy, or collision failures before Retry. Missing worktrees/surfaces, a surface on the wrong worktree, or a deleted origin may require a fresh launch with valid placement. Pause and Resume are unavailable during preparation; interrupted preparation fails on restart and uses Retry for recovery. Cancel does not roll back resources or stop an in-flight setup hook.

For recovery after graph execution begins, read [Workflow recovery](workflow-recovery.md).
