# Choose a workflow environment

A workflow runs in one destination: a worktree and a surface. Its origin records where it was launched. Without a caller override or an `environment` hook, the destination is the worktree and surface captured at launch; switching the active UI later does not retarget it. Start with [Workflow authoring](workflows.md) for package structure and verification. Consult the installed SDK's `launch.d.ts` and `graph.d.ts` for exact signatures.

## Choices and validation

The optional `environment(ctx, inputs)` hook on `defineWorkflow` returns a `WorkflowPlacementRequest`, synchronously or as a Promise. Both axes are required:

| Axis | Choice | Meaning |
| --- | --- | --- |
| Worktree | `{ kind: 'current' }` | Use the origin worktree. |
| Worktree | `{ kind: 'existing', worktreeId }` | Use that worktree in the launch project. |
| Worktree | `{ kind: 'create', branch, fromRef }` | Create a new branch and worktree from the commit resolved from `fromRef`. |
| Surface | `{ kind: 'current' }` | Use the origin surface, if it belongs to the chosen worktree. |
| Surface | `{ kind: 'existing', surfaceId }` | Use that surface, if it belongs to the chosen worktree. |
| Surface | `{ kind: 'create', title }` | Create a surface on the chosen worktree. |

A new worktree requires a new surface. `current` and `existing` surfaces are refused with a `create` worktree. Choosing an existing worktree does not move the origin surface: `surface: current` works only when that worktree is the origin worktree. Missing resources, worktrees outside the launch project, surfaces on another worktree, and destination surfaces occupied by an attached run are refused rather than silently substituted.

Creation requires a valid new branch name and a resolvable `fromRef`. The runtime records both the requested ref and its resolved commit before allocation, then creates from that commit; a branch moving later does not change the base. A collision rejects the launch with `workflow_environment_collision`. The common case of a branch that already has a worktree reports `collision: 'branch'`, because Git's branch list is checked first. `collision: 'worktree'` is only reached for a stale worktree row whose branch Git no longer has. Checkout-path collisions are reported separately as `collision: 'checkout_path'`.

Surface titles are labels, never identity. A duplicate title gains a numeric suffix instead of being refused. The surface receipt records `requestedTitle` and the effective `title`. Use surface IDs when selecting existing surfaces; matching a title does not prove a surface belongs to this run. The runtime's creation key makes retries converge on the same created surface; authors do not supply that key.

## Read-only discovery

The context exposes `origin`, `project: { id, name, kind }` (`kind` is `git` or `folder`), and two Promise-returning methods:

- `listWorktrees()` returns the launch project's recorded worktrees: `{ id, path, branch, head, isRoot }`. `branch` and `head` can be null and are null for folder projects.
- `listSurfaces({ worktreeId })` returns `{ id, worktreeId, title }` for that worktree. A worktree outside the launch project is rejected. The results do not report whether a surface is available for a run.

These reads do not reconcile Git or the filesystem, so rows can lag reality. A read is not a reservation: choices are validated at launch, checked again during preparation, and surface occupancy is checked when the destination is committed. Await discovery inside the hook; its context closes when the hook finishes and later discovery calls reject.

The supplied context has no allocation, agent-launch, or suspension capabilities. Keep selection to discovery and deterministic computation. This capability boundary is not a sandbox: the hook is trusted runtime code, and neither the loader nor verifier prevents direct IO. There is no timeout, just as for `command` and `validate`; slow work delays the launch.

## Derive names from inputs

Use validated inputs to choose stable names. For example, validate `ticket` as a positive integer string in `validate`, then assign this function to the definition's `environment` member:

```ts
import type {
  WorkflowEnvironmentContext,
  WorkflowPlacementRequest,
} from '@yourtechbudstudio/isagi-workflow-sdk';

function environment(
  ctx: WorkflowEnvironmentContext,
  inputs: { readonly ticket: string },
): WorkflowPlacementRequest {
  const title = `Ticket ${inputs.ticket}`;
  if (ctx.project.kind === 'folder') {
    return { worktree: { kind: 'current' }, surface: { kind: 'create', title } };
  }
  return {
    worktree: { kind: 'create', branch: `ticket-${inputs.ticket}`, fromRef: 'HEAD' },
    surface: { kind: 'create', title },
  };
}
```

Stable naming does not make a second launch a retry. This example deliberately requests creation; launching it again with the same ticket in a Git project rejects the existing branch. To reuse a worktree, discover it and explicitly return `existing` with its ID. A folder project can reuse its environment and create surfaces, but creating a worktree requires Git and rejects with `workflow_worktree_creation_unsupported`.

## Overrides, ordering, and provenance

A caller can supply `placement` in the start request, using the same two-axis shape. Precedence is caller override, then author hook, then current/current default. An override bypasses `environment` entirely; it bypasses neither input validation nor placement validation. The order is `command → validate → environment → prepare → init`, with placement selection supplied by the override or default when the hook does not run.

The launch request waits for preparation: worktree, setup, surface, then destination commit. The root graph's `init(destination, parameters)` is pure and synchronous, runs after preparation, and receives the effective destination and validated inputs. An initialized frame is not initialized again on Retry. Subgraphs inherit the root environment; composition cannot allocate a different room mid-run.

The run summary's `preparation.source` is `override`, `selector`, or `default`; `preparation.request` retains the choice, and `preparation.baseCommit` retains a creation base. `destination` reports the effective worktree and surface once preparation commits. The inspector shows a placement line for non-default placement with its provenance; ordinary default placement adds no line.

## Partial failures and Retry

Selection and static-validation rejections happen before a run or resources are allocated. A hook that throws or returns a malformed placement rejects with `workflow_environment_selection_failed`. After validation, a run is recorded before preparation allocates anything. A preparation failure leaves that run inspectable; receiving a run ID from the start request alone does not prove preparation succeeded. Inspect `preparation.status` (`pending`, `prepared`, `failed`, or `cancelled`) and its failure detail.

Receipts record what this launch allocated: worktree identity, path, branch and creation/adoption evidence; setup outcome and failure information; surface identity and requested/effective titles. Reusing an existing worktree or surface leaves no allocation receipt, and reused worktrees do not run setup. Receipts are historical evidence, not a promise those resources still exist. An interrupted allocation can leave a resource before its receipt was recorded; Retry checks for eligible adoption rather than assuming absence.

Retry adopts the latest compatible verified build but replays the recorded placement request and base commit. It never re-runs `environment`, so editing the hook does not relocate a failed run. It reuses recorded allocations after checking they still exist, can adopt the worktree left by an interrupted creation when ownership checks match, and uses the runtime creation key to recover a created surface without duplicating it.

For a created or adopted worktree, setup re-runs unless its receipt is `succeeded` or `skipped`. That includes `failed`, a missing receipt after interruption, and `unknown` after adoption. Setup hooks must be idempotent: they may have already performed some or all of their work. See [Project config](config-project.md) for setup hooks and trust. Grant required trust before retrying `setup_trust_required`; resolve an occupied surface or a collision before retrying those failures.

Retry cannot repair a placement whose recorded IDs no longer resolve. The launch outcome offers Close only for `worktree_missing`, `surface_missing`, and `surface_not_on_worktree`; start the workflow again with a valid placement. Separately, if the origin worktree was deleted after a preparation failed, Retry refuses with `workflow_environment_unavailable`: it needs that origin to resolve the workflow registry, even though the origin does not determine the destination. Start again from an available environment.

Nothing is ever deleted automatically on a preparation failure or cancellation: worktrees, branches, folders, and surfaces are retained. Cancel preserves recorded receipts and does not imply rollback; preparation does not interrupt an in-flight setup hook. Pause and Resume are refused during preparation with `workflow_run_preparing`. See [Workflow recovery](workflow-recovery.md) for recovery after graph execution has begun.
