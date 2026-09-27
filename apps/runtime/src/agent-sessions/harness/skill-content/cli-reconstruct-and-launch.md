# Reconstruct files and launch a fresh run

`checkpoints export` rebuilds captured filesystem state; `runs launch` starts a separate fresh execution. For runtime access and output conventions, see [CLI basics](cli-investigate-runs.md#runtime-and-output). For capture coverage, see [Workflow checkpoints](workflow-checkpoints.md#coverage-and-limitations).

## Worked example: reuse phase 1

Find the checkpoint after phase 1, inspect its coverage, export it, then launch the workflow being tested. Substitute the IDs each command returns.

```sh
isagi runs list --workflow implement-story --json
isagi executions list --run 42 --node phase --json
isagi checkpoints list --run 42 --execution 139 --descendants --json
isagi checkpoints inspect wcp_6a3c9e21-4b7d-4f0a-9c2e-8d1f5b7a3e64 --run 42 --resolved --json
isagi checkpoints export wcp_6a3c9e21-4b7d-4f0a-9c2e-8d1f5b7a3e64 --run 42 --output ~/isagi-experiments/phase-2-retry --json
```

Here execution 139 represents phase 1. `inspect --resolved` includes every page of final files, required absences, scopes, and warnings. Plain `inspect` shows metadata; `--manifest` shows layers for diagnosis and cannot combine with `--resolved`. Export already applies the resolved state; there is no layer replay for the agent to perform.

## Destination and coverage

Run export on the runtime's machine. Choose an absent or empty directory outside every checkout, such as the absolute scratch path above. Relative `--output` paths resolve from CLI cwd; captured paths resolve beneath the export root. Export from inside a checkout to `./experiment-root` is therefore rejected. Use a destination outside checkouts even when their projects are no longer registered or available.

A Git checkpoint exports into a detached worktree at its own recorded commit. A folder/unborn checkpoint exports captured files into a plain folder. Git export requires the source repository and exact commit to remain available; Isagi retains no commit ref and provides no fallback. Failures report `workflow_checkpoint_repository_unavailable` or `workflow_checkpoint_commit_unavailable` before creating the worktree.

Git export runs no Isagi setup hooks or post-create commands. Native Git hooks can still run and add files; inspect them when faithful reproduction matters. Prepare uncaptured dependencies and services separately. Regular dependency/build files can be present in the baseline or scopes; their presence and usability are not guaranteed.

## Check the result

With `--json`, export returns a status document even when it fails after runtime targeting. Syntax/targeting failures use the usual error document. Proceed only when `status` is `complete` and coverage is adequate. Inspect `destinationPath`, `worktreeId`, `applied`, `resolvedWarningCounts`, and `limitations`. A plain-folder export has no worktree ID.

| Limitation | Meaning |
| --- | --- |
| `git_baseline_is_committed_state_only` | Uncommitted changes require explicit capture. |
| `no_baseline_captured_files_only` | Only declared captured files are reconstructed. |
| `dependencies_not_captured` | Dependency readiness is not guaranteed; inspect coverage and prepare missing dependencies. |

For `failed` or `uncertain`, inspect `failure` and `failure.created` before acting. `created.destination` says whether a nonempty destination remains: true, false, or null for unknown. Partial worktrees/files remain; export does not automatically retry or clean them up. An uncertain creation may have succeeded despite a lost response. Inspect the destination and Isagi's worktree listing before cleanup or a new export; never blindly repeat the creation.

`failure.stage` identifies the failed action: `resolve_destination` checks the target; `read_checkpoint` fetches metadata/inventory; `validate_inventory` checks paths; `prepare_baseline` creates the folder/worktree; `apply_absences` removes required paths; `write_files` restores captured bytes/modes with integrity checks. See [CLI troubleshooting](cli-investigate-runs.md#troubleshooting) for codes. Exit status is 1 for failed/uncertain exports.

## Launch separately

Prepare and verify the workflow in the origin worktree using [Workflow authoring](workflows.md#completion-and-verification), then confirm discovery and launch:

```sh
isagi workflows list --json
isagi runs launch implement-story --inputs @inputs.json --worktree-placement existing:31 --surface-placement 'create:Phase 2 retry' --json
isagi runs inspect 57 --json
```

Use the export's `worktreeId` (31 here) as destination. The origin selects the workflow package; it is separate from the exported destination. By default origin is the Isagi worktree containing cwd and its focused surface. Pass `--worktree <id> --surface <id>` together to choose it explicitly. Origin must belong to the destination's project. A plain-folder export must be registered/selected as a folder project before it can be a launch destination; it cannot use the Git worktree ID example.

`--inputs` accepts a JSON object or `@file`. Retrieve original inputs through `runs inspect` and its root frame's `parametersRef` if needed. Give both placement flags or neither; without them the workflow's environment hook/default decides. See [Workflow environments](workflow-environments.md) for placement choices. Inspect the new run's preparation status and effective destination; a run ID alone does not prove successful preparation.

The new run starts at its workflow entry with fresh graph state and sessions. To exercise only part of a workflow, author and verify a workflow for that portion using captured files as inputs. Export does not choose that scope. Record source run/checkpoint IDs, new run ID, workflow version, and changed inputs/settings in your notes; Isagi does not automatically link the launch to its export.
