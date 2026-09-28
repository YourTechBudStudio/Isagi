# Reconstruct files and launch a fresh run

`checkpoints export` rebuilds a checkpoint's files in a new folder; `runs launch` starts a separate, fresh run. For runtime access and output conventions, see [CLI basics](cli-investigate-runs.md#runtime-and-output). For what a checkpoint holds, see [Workflow checkpoints](workflow-checkpoints.md#what-a-checkpoint-holds).

## Worked example: rerun from phase 1

Find the checkpoint taken after phase 1, check what it holds, export it, then launch the workflow being tested in the export.

```sh
isagi runs show 42 --json
isagi checkpoints list --run 42 --execution 139 --json
isagi checkpoints show 5 --json
isagi checkpoints export 5 --output ~/isagi-experiments/phase-2-retry --json
```

Execution 139 is the phase 1 checkpoint node here; `checkpoints list --scope <name>` finds checkpoints by scope instead. `checkpoints show` returns the commit and every scope with its files (`path`, `sha256`, `sizeBytes`, `executable`) and a `missing` marker. Check it holds everything the next run needs before exporting: a checkpoint holds only the scopes its plan named.

## What export does

Export is one runtime call:

1. It checks the folder: it must be absent or empty, outside every checkout Isagi knows, and not the target of another export in progress. A relative `--output` is resolved from the current directory.
2. A checkpoint with a commit becomes a detached Isagi worktree at that commit, in the run's project. A checkpoint without one (a folder project or a repository with no commits) becomes an empty folder.
3. Each captured directory is made to match its copy exactly: regular files the copy does not have are deleted, except excluded paths, and every captured file is written with its executable bit. Folders emptied by those deletions are removed. A scope captured as missing ends up absent, except for excluded paths, symlinks and special files the commit has there, which are kept and keep their folder. Where the commit has a file for a captured folder, or the reverse, the captured shape replaces it. Symlinks, special files and nested `.git` entries inside a scope are left as the commit has them.

It returns `{ destinationPath, worktreeId }`; `worktreeId` is null for a plain folder. Export runs no Isagi setup hooks or post-create commands, though Git's own hooks can still run during `git worktree add`. Dependencies and services the scopes did not capture are not restored.

| Failure | Meaning |
| --- | --- |
| `workflow_checkpoint_destination_rejected` | The folder is not usable; `data.destinationIssue` says why (`not_empty`, `inside_checkout`, …). Nothing was created. |
| `workflow_checkpoint_commit_unavailable` | The commit is gone (squashed, rebased or discarded), or the project is missing or no longer a Git repository. Isagi keeps no ref to a checkpoint's commit, so this is a known limitation. Nothing was created. |
| `workflow_checkpoint_export_failed` | Something failed after the folder or worktree was created. The message names the step and path and says whether the destination has content; `data.worktreeId` is set when a worktree was registered. Nothing is cleaned up: inspect the destination before removing it or exporting again. |

## Launch separately

Prepare and verify the workflow in the origin worktree using [Workflow authoring](workflows.md#completion-and-verification), then confirm discovery and launch:

```sh
isagi workflows list --json
isagi runs launch implement-story --inputs @inputs.json --worktree-placement existing:31 --surface-placement 'create:Phase 2 retry' --json
isagi runs show 57 --json
```

Use the export's `worktreeId` (31 here) as the destination. The origin selects the workflow package and is separate from the destination. By default the origin is the Isagi worktree containing the current directory and its focused surface, if it has one; pass `--worktree <id>` (optionally with `--surface <id>`) to choose it. The origin must belong to the destination's project. A plain-folder export has no worktree ID: add it to Isagi as a folder project before it can be a launch destination.

`--inputs` accepts a JSON object or `@file`. The original run's inputs are in `runs show` as `inputs`. Give both placement flags or neither; without them the workflow's `environment` hook decides. See [Workflow environments](workflow-environments.md) for placement choices. Check the new run's status and environment events: a run ID alone does not prove its worktree and surface were prepared.

The new run starts at its workflow's entry with fresh graph state and sessions. To exercise only part of a workflow, author a workflow for that part that reads the exported files as its inputs. Record the source run and checkpoint IDs, the new run ID and changed inputs in your notes; Isagi does not link the launch to its export.
