# Reconstruct a checkpoint and launch a fresh run with the `isagi` CLI

`isagi checkpoints export` rebuilds one checkpoint's saved files in an empty folder: a detached Git worktree at the checkpoint's own base commit, or a plain folder when the checkpoint has no Git base. `isagi runs launch` then starts a separate, fresh run wherever you place it. Export never launches anything, and launch never exports.

Read [CLI investigation](cli-investigate-runs.md) first for reaching the runtime, `--json`, the error document, exit status, and pages. [Workflow checkpoints](workflow-checkpoints.md) explains what a checkpoint saves, and [Workflow environments](workflow-environments.md) explains placement.

## Find the checkpoint

```sh
isagi checkpoints list --run 42 --execution 140 --descendants --json
isagi checkpoints inspect wcp_6a3c9e21-4b7d-4f0a-9c2e-8d1f5b7a3e64 --run 42 --json
isagi checkpoints inspect wcp_6a3c9e21-4b7d-4f0a-9c2e-8d1f5b7a3e64 --run 42 --resolved --json
isagi checkpoints inspect wcp_6a3c9e21-4b7d-4f0a-9c2e-8d1f5b7a3e64 --run 42 --manifest --json
```

- `checkpoints list --execution <id> --descendants` lists every checkpoint saved anywhere inside one execution's subtree, for example one phase of a phase-wise workflow.
- `inspect` shows the base, counts and warning groups; `--resolved` adds the final inventory, which is exactly what export applies: the captured scopes, the files, the paths that must be absent, and warnings about what was not captured.
- `--manifest` shows how each layer arrived at that state. It is for inspection only. Export never reads the manifest and never replays earlier checkpoints: the runtime has already resolved the final state.

## Export

```sh
isagi checkpoints export wcp_6a3c9e21-4b7d-4f0a-9c2e-8d1f5b7a3e64 --run 42 --output ~/isagi-experiments/phase-2-retry --json
```

`--output` names the export root, resolved against the current directory. Every path in the checkpoint is relative to that root, never to the current directory. Missing parent directories are created.

### The destination

The export root must be absent or an empty directory:

- A path that exists and is not a directory is refused (`not_directory`). A symlink is refused the same way and is never followed.
- A directory with entries is refused (`not_empty`).
- A path that cannot be inspected or resolved is refused (`inaccessible`).

It must also not be, or be inside, any checkout:

- the checkpoint's source worktree (the run's own destination), even when Isagi lists its project as missing (`data.sourceWorktree: true`);
- any project root Isagi knows;
- any worktree Isagi lists (`data.worktreeId`).

Each of these is `inside_checkout`. For a Git export the runtime checks again and also refuses any checkout that Git itself lists for that project. One limit remains: a directory-only export cannot see linked worktrees of *other* projects that Isagi lists as missing, so do not export into one.

Because of this rule, `--output ./experiment-root` run from inside a worktree is refused with `inside_checkout`. Export to an absolute scratch location outside every checkout, such as `~/isagi-experiments/<name>`. All of these checks run before anything is created, and a refused destination fails with `export_destination_rejected` and `data.destinationIssue`.

### What export does

Export runs these stages in order and stops at the first failure. Progress goes to stderr, one line per stage and at most one `wrote <n>/<m> files` line a second.

| Stage | What happens |
| --- | --- |
| `resolve_destination` | Checks the destination as above. Nothing is written. |
| `read_checkpoint` | Reads the checkpoint and every page of its resolved inventory. |
| `validate_inventory` | Refuses an inventory that cannot be applied safely: a path that is absolute, empty, contains `..`, `.`, an empty segment or a NUL, or names `.git` in any letter case (`export_path_unsafe`); a file listed twice, a path that is both a file and an absence, a file that is also another file's directory, or two files whose names differ only by letter case or Unicode normalization (`export_inventory_conflict`). |
| `prepare_baseline` | Git base: the runtime creates a detached worktree at the checkpoint's own commit, at the destination. No base: the empty folder is created. |
| `apply_absences` | Removes each path the checkpoint says must be absent, if the baseline has it, and then removes directories that removal left empty. A directory where an absent path should be is `export_path_conflict`. A path whose parent is missing, a symlink or not a directory is already absent and is never followed. |
| `write_files` | Writes every saved file, checking its size and sha256, and sets its executable bit. A file is written to a temporary file beside it and renamed into place only once it matches. A parent that is a symlink or not a directory is `export_path_unsafe`, and nothing is written through it; a directory where a file should be is `export_path_conflict`. |

### Git baseline, no baseline, and what is not included

- **A Git baseline is committed state only.** The worktree starts at the commit the checkpoint recorded, plus the captured files. Uncommitted changes that were outside every captured scope at capture time are not there; the checkpoint reports them as `uncaptured_dirty_path` warnings.
- The new worktree is detached: no branch is created or moved. Isagi runs no setup hooks, trust prompts or post-create commands for it. **Git repository hooks still run**, as for any `git worktree add`; a `post-checkout` hook can add files that are not in the checkpoint.
- The worktree belongs to the checkpoint's project, and Isagi lists it after its next workspace refresh. Remove it through Isagi when you no longer need it.
- **No baseline** (a folder project, or a repository with no commit yet): the export root is a plain folder holding only the captured files. It is not a Git checkout.
- **Dependencies are outside the guarantee.** Installed packages, build output, environment variables, databases and services were never captured. Install and build them yourself before relying on the result.

### Unavailable bases

Isagi does not retain checkpoint base commits. When Git has discarded the commit (after a branch deletion, a squash merge or garbage collection), that checkpoint cannot be exported: export fails at `prepare_baseline` with `workflow_rejected` and reason `workflow_checkpoint_commit_unavailable`, before creating anything. When the repository itself is gone, the reason is `workflow_checkpoint_repository_unavailable`. There is no fallback; the checkpoint's metadata and inventory stay inspectable.

## The export result

With `--json`, every export that got past the command line and runtime targeting prints one `ExportResult` document, including a failed one; it is not an error document. Command-line and targeting failures print the usual error document. Without `--json`, a short text summary is printed instead. Exit status is `0` for `complete` and `1` for `failed` or `uncertain`.

| Field | Meaning |
| --- | --- |
| `status` | `complete` only when every stage finished. `failed` when a stage failed. `uncertain` when the runtime may or may not have created the worktree. |
| `runId`, `checkpointId` | What was exported. |
| `destinationPath` | The canonical export root; after the runtime created a worktree, the path it created. |
| `base` | The checkpoint's base: `{ kind: "git", repositoryId, commitSha }` or `{ kind: "none", reason }`. `null` only when the checkpoint could not be read. |
| `worktreeId` | The new worktree's id, once one exists; `null` for a directory-only export. |
| `counts` | The checkpoint's own counts of scopes, files, absences and warning rows. |
| `applied` | How many files and absences were applied. |
| `resolvedWarningCounts` | For each warning reason, how many paths or observations it affects across the exported inventory, including warnings inherited from earlier checkpoints. It is not a breakdown of `counts.warnings`, which counts warning rows: when uncaptured dirty paths were truncated, `uncaptured_dirty_path` here includes the omitted ones. |
| `limitations` | Always `dependencies_not_captured`, plus `git_baseline_is_committed_state_only` for a Git base or `no_baseline_captured_files_only` without one. |
| `failure` | `null`, or `{ stage, code, reason?, message, requestId?, data?, created }`. `stage` is one of the stages above; `code`, `reason`, `requestId` and `data` follow the error document. |

`failure.created` says what the failure left behind:

- `destination: true` means the export root exists and is not empty; `false` means nothing was created inside it; `null` means Isagi cannot know.
- `worktreeId` is set once a worktree is known to exist.

Isagi never retries an export and never cleans up after one. A worktree that holds only the baseline, or only some of the files, is left in place and reported as `failed`. Empty parent directories of the export root may remain after any failure, for both Git and directory-only exports.

**`uncertain` means inspect before acting.** The request to create the worktree was sent, but its answer was lost, so the runtime may or may not have created it. Do not re-run the same command blindly. Look at the export root: if it holds a `.git` entry, a worktree was created, and Isagi lists it once its workspace refreshes. Remove it, or export again to a new, empty path.

### Export failure codes

Runtime rejections pass through with their own code and reason, for example `workflow_rejected` with `workflow_checkpoint_commit_unavailable`, `workflow_checkpoint_repository_unavailable`, `workflow_checkpoint_destination_rejected`, `workflow_checkpoint_worktree_failed` (whose `data.created` becomes `failure.created.destination`), or `workflow_checkpoint_content_unavailable` for a saved file that is missing or corrupt. An error with any other code leaves what was created unknown. The CLI's own codes:

| Code | Meaning |
| --- | --- |
| `export_destination_rejected` | The export root is not empty, not a directory, cannot be inspected, or is inside a checkout; `data.destinationIssue` says which. Nothing was created. |
| `export_destination_not_visible` | The runtime created the worktree, but it is not visible from where the CLI runs. The CLI must run on the runtime's machine. The worktree is left in place. |
| `export_path_unsafe` | An inventory path is not a safe relative path, or writing it would pass through a symlink or a non-directory. |
| `export_path_conflict` | A directory sits where an absent path or a file must go. |
| `export_inventory_conflict` | The inventory lists colliding files: the same path twice, a path as both a file and an absence, a file that is also another file's directory, or names that collide on a case-insensitive filesystem. |
| `content_integrity_mismatch` | A saved file's bytes did not match its recorded size or sha256. Its temporary file was removed. |
| `runtime_unreachable` | The runtime did not answer, or a file's content stream broke part-way. When creating the worktree, a refused connection is `failed`; any other lost answer is `uncertain`. |
| `runtime_response_invalid` | The runtime's answer broke a rule: for example the run has no recorded destination, or the worktree it created has a different base or path than requested (the worktree is left in place). |
| `filesystem_write_failed` | A local write failed; `data` carries the path and `errno`. |

## Launch a fresh run

```sh
isagi workflows list --json
isagi runs launch implement-story --inputs @inputs.json --worktree-placement existing:31 --surface-placement 'create:Phase 2 retry' --json
```

`workflows list` prints `{ origin, workflows }`: the workflows launchable from the origin worktree. `runs launch <workflowKey>` starts a new run and prints `{ runId, workflowKey, origin, placement }`.

- **The workflow comes from the origin worktree.** The runtime discovers the workflow key there, so build and verify the workflow in that worktree first; see [Workflow authoring](workflows.md).
- **Inputs are explicit.** `--inputs` takes a JSON object, or `@<path>` to a file holding one, relative to the current directory; anything else is `cli_usage_invalid`. The workflow checks them against its own input schema. The source run's inputs are its root frame's `parametersRef` (`runs inspect`), readable with `payloads read`.
- **Placement after an export:** `--worktree-placement existing:<worktreeId> --surface-placement create:<title>`, with the `worktreeId` the export printed. The exported worktree is the placement, never the origin: it has no surface yet. The forms are `current`, `existing:<id>` and `create:<branch>:<fromRef>` for the worktree, and `current`, `existing:<id>` and `create:<title>` for the surface. Give both flags or neither. A surface title is everything after `create:`, colons included. With neither flag, the workflow's own `environment` hook decides, and the output shows `placement: null`; `runs inspect` shows where the run was actually placed.
- **The origin** is automatic unless you pass `--worktree <id> --surface <id>` (both together). The automatic origin is the Isagi worktree containing the current directory, plus the surface currently focused in that worktree, which may not be your own. The origin used is always printed. With `--surface-placement create:<title>`, the origin surface is only recorded as provenance. Pass `--worktree` and `--surface` when the current directory is outside the checkpoint's project, when that worktree has no focused surface (`origin_unresolved`), or when the run must attach to one particular existing surface.

| Code | Meaning |
| --- | --- |
| `origin_unresolved` | No origin was given and none could be derived: the current directory is not inside any worktree Isagi knows, or that worktree has no focused surface. `data` carries `cwd` and, when found, `worktreeId`. Pass `--worktree` and `--surface`. |

A rejection from the runtime, such as an origin worktree outside the workflow's project, passes through with its own `code` and `reason`. Isagi does not record that a run started from an export. Keep the source run ID and checkpoint ID in your own notes.

## Worked example: launch an experiment

Phase 2 of run 42 went badly. To retry it from the state phase 1 left behind, with an edited workflow:

```sh
isagi executions list --run 42 --node phase --json
isagi checkpoints list --run 42 --execution 139 --descendants --json
isagi checkpoints inspect wcp_6a3c9e21-4b7d-4f0a-9c2e-8d1f5b7a3e64 --run 42 --resolved --json
isagi checkpoints export wcp_6a3c9e21-4b7d-4f0a-9c2e-8d1f5b7a3e64 --run 42 --output ~/isagi-experiments/phase-2-retry --json
isagi workflows list --json
isagi runs launch implement-story --inputs @inputs.json --worktree-placement existing:31 --surface-placement 'create:Phase 2 retry' --json
isagi runs inspect 57 --json
```

1. `executions list --node phase` finds the phase visits; phase 1 is execution 139 here.
2. `checkpoints list --execution 139 --descendants` finds the checkpoint saved at the end of phase 1; `inspect --resolved` shows what it holds and what it does not cover.
3. `checkpoints export` rebuilds it under a scratch folder outside every checkout. Check `status` is `complete`, and note the `worktreeId` (31 here) and `limitations`. Install dependencies in the export if the workflow needs them.
4. Edit, build and verify the workflow in the worktree you launch from, then run `workflows list` from there to confirm it is launchable and to see the origin that will be used.
5. `runs launch` starts the fresh run in the exported worktree on a new surface, with explicit inputs. Record run 42, the checkpoint ID and the new run ID (57 here) in your notes.
6. `runs inspect` confirms where the new run was placed and how it is progressing.
