# Checkpoints

A `checkpoint` node records the checkout's Git `HEAD` commit plus an exact copy of the files and folders its plan names, and nothing else: no graph state, sessions, terminals, processes, or anything from earlier checkpoints. Field rules and limits are in the installed `checkpoints.d.ts` and `nodes.d.ts`. [Export](cli-reconstruct-and-launch.md) rebuilds a checkpoint in a new folder.

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

## Placing one

- After meaningful completion or approval, before useful files are overwritten or deleted, and at the end of a run.
- After every writer touching the scopes has finished (agent turns and commands). Capture is not atomic, so a file changing mid-copy may be saved half-written.
- Capture everything a rebuild needs in each checkpoint you plan to export. Phase directories such as `work/research` and `work/design` make that easy.
- Reuse a `scope` name for the same thing across visits (`plan` every round) so `isagi workflows checkpoints list --run <id> --scope plan` lists every version.
- Exclude secrets, dependencies, caches and generated bulk; ignored files inside a scope are captured and there is no size cap.

Paths are relative to the checkout root with `/`; absolute paths, `..` and `.git` are refused. A checkpoint node has one outgoing edge and leaves graph state unchanged.

## What it holds

- Regular files only, with the owner-execute bit. Symlinks, special files and nested `.git` inside a scope are skipped; a scope path through a symlink fails the capture.
- A scope path that does not exist is recorded as missing.
- Committed state comes from the commit. Uncommitted, untracked and ignored files are present only when a scope covers them.
- The commit is recorded but no Git ref keeps it. If it is later squashed, rebased away or discarded, export fails while the metadata and files stay readable. Folder projects and repositories with no commits record no commit.

## Failures

A plan that breaks a rule fails at stage `checkpoint_plan`; a filesystem or Git problem fails at `checkpoint_capture`. Nothing is saved either way: fix the plan or the checkout and Retry. Once saved, a checkpoint is part of its execution's result, so a Retry of a later failure reuses it and never captures again. Checkpoints survive cancelling or dismissing the run and removing its worktree.
