# Place workflow checkpoints

A checkpoint records two things: the Git `HEAD` commit of the run's checkout at that moment, and an exact copy of the files and folders its plan names. That is all it is. Nothing is inherited from earlier checkpoints, and graph state, execution position, agent sessions, terminals and processes are not part of it. Export rebuilds the files in a new folder; see [CLI reconstruction](cli-reconstruct-and-launch.md).

## Choose the boundary

Place checkpoints after meaningful completion or approval, before useful files are overwritten or deleted, and at the end of a run. Finish every writer before the checkpoint node: wait for agent turns, headless work and commands touching the scopes. Capture is not an atomic filesystem snapshot, so a file changing while it is copied may be saved half-written.

Phase directories make handoffs easy to capture, for example `work/research` and `work/design`. Exclude secrets, dependencies, caches and generated bulk. Ignored files inside a scope are captured too. There is no byte or file-count cap.

## Declare the node

```ts
import { checkpoint } from '@yourtechbudstudio/isagi-workflow-sdk';

type State = { readonly round: number };

export const savePlan = checkpoint<State>({
  title: 'Save the plan',
  label: (state) => `round ${state.round}`,
  plan: () => ({
    capture: [
      { scope: 'plan', directory: 'work/plan', exclude: ['drafts'] },
      { scope: 'decisions', file: 'decisions.md' },
    ],
  }),
});
```

Register one outgoing edge, as for an operation; the checkpoint leaves graph state unchanged. `plan(state)` is pure and synchronous and runs only when the node is visited. Consult the installed SDK's `checkpoints.d.ts` and `nodes.d.ts` for fields and limits.

Paths are relative to the run's checkout root and use `/`; absolute paths, `..` and `.git` paths are refused. Directory scopes accept scope-relative `exclude` paths, without globs. Scopes in one plan cannot overlap. An empty `capture` list records only the commit.

## What a checkpoint holds

- **Exactly what it names.** A scope the plan leaves out is simply not in this checkpoint. Capture everything a rebuild needs in every checkpoint you intend to export.
- **Regular files only.** Symlinks, special files and nested `.git` entries inside a directory scope are skipped. A scope path that passes through a symlink fails the capture rather than copying something outside the checkout.
- **Missing paths are recorded as missing.** If a scope's path does not exist, the checkpoint says so, and export makes that path absent.
- **The owner-execute bit** is kept; other modes are not.
- **The commit is recorded, not kept.** There is no Git ref. If the commit is later squashed, rebased away or discarded, export of that checkpoint fails (`workflow_checkpoint_commit_unavailable`); its metadata and saved files stay readable. Folder projects and repositories with no commits record no commit and export into a plain folder.
- **Committed state comes from the commit.** Uncommitted changes, untracked and ignored files are only in the checkpoint when a scope covers them.

`scope` is a stable name for listing and comparing. Reuse it for the same thing across visits, for example `plan` in every round, so `isagi checkpoints list --run <id> --scope plan` shows every version of the plan. See [CLI investigation](cli-investigate-runs.md#compare-plan-versions).

## Failures and Retry

A plan that breaks a rule fails the execution with stage `checkpoint_plan`; a filesystem or Git problem while copying fails it with stage `checkpoint_capture`. Either way nothing is saved. Read the message, fix the plan or the checkout, then Retry: the capture runs again.

Once a checkpoint is saved it is part of the execution's result. A Retry of a later failure (the edge after it, for example) reuses that checkpoint and never captures again, even if the files have changed since.

Saved checkpoints are kept when a run is cancelled, dismissed or its worktree removed.
