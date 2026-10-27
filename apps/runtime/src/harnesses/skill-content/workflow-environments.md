# Environments

A run's destination is a worktree plus a surface. Types and per-field rules for `placement`, its context and choices are in the installed `launch.d.ts`.

## Who decides

From highest precedence: a placement the caller passes with the launch (it skips the hook), the workflow's optional `placement(ctx, parameters)` hook, then the default (current worktree and surface as captured at launch, or a new surface titled after the command when the origin had none). Switching the UI later never retargets a run. The order is `command → parse → placement → preparation → init`; subgraphs inherit the root destination.

| Axis | Choices |
| --- | --- |
| Worktree | `current`, `existing` by ID, `create` with a new `branch` and `fromRef` |
| Surface | `current`, `existing` by ID, `create` with a `title` |

Existing resources must belong to the launch project, the surface must belong to the chosen worktree and be free of an attached run, and a new worktree needs a new surface. Folder projects cannot create worktrees. A branch that already exists fails creation rather than implying reuse. Surface titles are labels; duplicates get a numeric suffix.

Keep the hook to discovery (`listWorktrees`, `listSurfaces`) and deterministic choice; do agent work in graph operations.

```ts
import type {
  WorkflowPlacementContext,
  WorkflowPlacementRequest,
} from '@yourtechbudstudio/isagi-workflow-sdk';

// Assumes `parse` checked that `ticket` is a positive integer string.
export function placement(
  ctx: WorkflowPlacementContext,
  parameters: { readonly ticket: string },
): WorkflowPlacementRequest {
  return {
    worktree: ctx.project.kind === 'folder'
      ? { kind: 'current' }
      : { kind: 'create', branch: `ticket-${parameters.ticket}`, fromRef: 'HEAD' },
    surface: { kind: 'create', title: `Ticket ${parameters.ticket}` },
  };
}
```

A second launch for the same ticket would collide on the branch; to reuse a worktree, find it with `listWorktrees` and return `existing`.

## Preparation

A run starts `preparing`, and each step is saved on the run with an environment event: create the worktree (`worktree_created`), run its [setup hooks](config-worktree-setup.md) (`setup_finished` or `setup_failed`, with output), create the surface (`surface_created`). A failure appends `preparation_failed` and leaves the run `failed` at stage `environment`, so a returned run ID alone does not prove preparation succeeded. The run summary's `placement` records the request, its `source` (`override`, `selector` or `default`), the resolved `baseCommit`, and what has been produced so far.

A created surface starts empty, and the run's first agent becomes its first pane. Closing the last pane leaves the surface in place.

## Failed preparation

Retry skips every step already saved: it never creates a second worktree, and it uses the recorded base commit even if the ref has moved. Editing `placement` does not relocate an existing run. Resolve trust, occupancy or branch collisions before Retry. A deleted `current` or `existing` surface fails again, because a run never replaces a surface it did not create; missing resources or a deleted origin may need a fresh launch. Pause and Resume are unavailable while preparing; preparation interrupted by a restart fails and recovers with Retry. Cancel rolls nothing back and does not stop an in-flight setup hook.
