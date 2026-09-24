# Place workflow checkpoints

A checkpoint saves a filesystem boundary: the files a workflow declares, as they are in the run's destination when the checkpoint node is visited, plus the Git commit that visit started from. Later, that boundary can be inspected and rebuilt as final state. A checkpoint is not an execution snapshot. It does not save graph state, agent sessions, terminals, processes, or anything outside the declared scopes, and it never rewinds a run.

Read [Workflow authoring](workflows.md) for graph structure and package checks, [Agent work](workflow-agents.md) for turn handling, and the installed SDK's `checkpoints.d.ts` and `nodes.d.ts` for exact types.

## Where to place one

Checkpoint proactively, at points someone may want to return to or compare against:

- after a phase completes or a person approves it, so the approved result is kept;
- before work that will overwrite or delete what exists, so the earlier version survives;
- at the end of a run, to seal what it leaves behind.

A checkpoint captures what is on disk when its node is visited, so every writer must be finished. Route to the checkpoint only after the agent turn, headless job, or operation that wrote the files has ended; do not leave an agent or command writing into a scope while it is captured. If the files change during capture, the checkpoint is refused rather than saved half-changed.

## The node and its plan

```ts
import { checkpoint } from '@yourtechbudstudio/isagi-workflow-sdk';

type PhaseState = { readonly phase: number };

export const savePhase = checkpoint<PhaseState>({
  title: 'Save the phase',
  description: 'The phase directory and the shared decisions file.',
  prepare: (state) => ({
    title: `Phase ${state.phase} saved`,
    capture: [
      { scope: `phase-${state.phase}`, directory: `work/phase-${state.phase}` },
      { scope: 'decisions', file: 'decisions.md' },
    ],
  }),
});
```

A checkpoint routes like an operation: exactly one edge leaves it, and graph state is unchanged. `title` and `description` are static metadata shown on the graph. `prepare(state)` is pure and synchronous. It receives a frozen copy of the frame state and returns a plan; it runs only when the node is visited, never during verification or inspection. Do not read files, call `ctx`, or return a promise from it.

| Plan field | Meaning and limits |
| --- | --- |
| `title?` | This visit's title. Defaults to the node's `title`, then its id. Trimmed, non-empty, at most 512 characters. |
| `capture` | Zero to 64 scopes. An empty list records the Git baseline and inherits everything earlier checkpoints covered. |
| `{ scope, directory, exclude? }` | Every regular file under `directory`, except the scope-relative files or directories in `exclude` (at most 64, no globs). |
| `{ scope, file }` | One regular file. |

Scope ids match `[a-z0-9][a-z0-9._-]{0,63}` and are unique within a plan. Paths are relative to the run's destination root (its worktree, or the folder for a folder project) and use `/`. Absolute paths, `..`, and any path containing a `.git` segment are refused. Two scopes of one plan must not overlap, including a file inside a directory scope. An optional field set to `undefined` is treated as absent.

Keep scopes focused on what someone would want back: the artifacts a phase produced, its notes, a generated report. Leave dependencies, build output, and caches out, or exclude them. There is no byte or file-count cap; capture size is your responsibility.

## Phase-wise directories

A useful pattern is one directory per phase, such as `work/phase-1`, `work/phase-2`, each captured by the checkpoint that ends that phase under a stable id such as `phase-1`. Each checkpoint then saves only what its phase wrote, earlier phases are inherited unchanged, and a later phase cannot silently rewrite an earlier phase's saved files. This is guidance, not a rule; any layout the scopes describe works.

## Layering, inheritance and stable ids

Each checkpoint builds on the run's previous checkpoint, whatever node or nested graph saved it. A scope the plan omits keeps whatever earlier checkpoints saved for it. **Omitting a scope never means delete it.** A scope the plan names is captured again from scratch: files that were added, changed, or deleted under it since are reflected, and its exclusions apply.

A scope id names one artifact or region for the whole run. A later plan that reuses the id must name the same path and the same kind (directory or file); changing either refuses the capture with `scope_identity_changed`. Changing a scope's exclusions is allowed. Adding an exclusion stops that scope capturing the subpath, so its previously saved files there are dropped unless another captured scope still covers them. To capture a different path, use a different id.

A wider scope captured later replaces the narrower regions inside it, and a narrower scope captured later replaces just its part of a wider one. Every file ends up in the final state once.

To record that something was deleted, capture its scope again after the deletion. A directory or file that no longer exists is accepted as an intentional empty capture only when an earlier checkpoint in this run covered that exact path, or when the baseline commit tracks it under that exact spelling; the checkpoint then carries a `scope_recaptured_empty` warning. A path that is missing for any other reason is refused as `scope_path_not_found`, so a typo can never turn into a deletion.

## The Git baseline and its limits

For a Git project, each checkpoint records the exact commit the destination's `HEAD` pointed at. Reconstruction starts from that commit and then applies the checkpoint's final state: the captured files, and the committed paths inside captured scopes that must be absent.

The baseline is committed content only. Staged, unstaged, untracked, and ignored changes, and deletions that are not committed, are in a checkpoint only when a scope captures them. Ignored files inside a scope are captured like any other file. Every Git checkpoint notes `ignored_paths_not_surveyed`, because ignored files outside scopes are never looked for. Uncommitted changes Git reports outside every captured scope, and inherited files that are still uncommitted but were not recaptured, are listed as `uncaptured_dirty_path` warnings; review them and widen a scope if they matter. An untracked inherited file that was deleted from disk is not noticed until its scope is captured again.

Symlinks and special files inside a scope are never captured and never recorded as deleted (`symlink_skipped`, `special_file_skipped`); the baseline decides them. A scope root that is itself a symlink is refused. A `.git` entry inside a scope, such as a nested repository's, is skipped (`nested_repository_skipped`). A tracked file that became a symlink or special file is left to the baseline. A file that became a directory, or a directory that became a file, must be committed before capture.

Spell every path exactly as the directory lists it. On a case-insensitive filesystem, a path that names an existing entry with different case or Unicode normalization is refused as `scope_path_spelling_mismatch`. Declare the deletion of something Git tracks under Git's exact spelling: a deleted path declared under another spelling is not matched to Git's entry, each tracked file under it is reported as a warning, and reconstruction restores it until the deletion is declared under Git's spelling. Renaming a captured path at the destination root only by case is not supported within one checkpoint.

The commit is recorded, not retained. Isagi creates no ref for it, so it can disappear after a branch is deleted, a squash merge, garbage collection, or removal of the repository. A checkpoint's metadata and saved files remain inspectable either way; restoring from it works only while Git can still open that exact commit, and a restore reports when it cannot.

A folder project, or a Git repository with no commits yet, has no baseline. Its checkpoints reconstruct into an empty directory with only the captured scopes; everything else in the destination is not part of them.

## Failures and warnings

A failure means nothing was saved. The visit fails, no checkpoint record exists, and the run waits on the node for Retry, which runs `prepare` and captures again. Fix the cause first.

| Failure code | Cause |
| --- | --- |
| `checkpoint_prepare_failed` | `prepare` threw (`detail.cause`), or its plan was refused (`detail.reason`, with `scopeId`, `field` or `path` where one applies) |
| `async_pure_callback` | `prepare` returned a promise |
| `checkpoint_capture_failed` | The capture was refused; `detail.reason` names why |

Plan reasons: `invalid_plan_shape`, `invalid_title`, `too_many_scopes`, `invalid_scope_shape`, `invalid_scope_id`, `duplicate_scope_id`, `invalid_scope_path`, `git_metadata_path`, `too_many_exclusions`, `invalid_exclusion`, `overlapping_scopes`.

Capture reasons: `scope_path_not_found`, `scope_root_is_symlink`, `scope_kind_mismatch` (a directory scope names a file or the reverse), `scope_path_spelling_mismatch`, `scope_identity_changed`, `path_identity_collision` (two saved paths would name one filesystem entry), `path_kind_conflict`, `path_inspection_failed` (a permission or I/O error), `unstable_capture` (files changed during capture), `head_changed` (`HEAD` moved during capture), `git_unavailable`, `git_inspection_failed`, `content_publish_failed`, `destination_unavailable`, and, after an edit adopted by Retry, `graph_not_declared` or `edge_not_declared`.

A warning belongs to a checkpoint that was saved and describes what it does not cover: `uncaptured_dirty_path`, `dirty_survey_unavailable` (Git's status could not be read, so uncommitted changes outside scopes are unknown), `ignored_paths_not_surveyed`, `symlink_skipped`, `special_file_skipped`, `nested_repository_skipped`, and `scope_recaptured_empty`. At most 1000 `uncaptured_dirty_path` warnings are kept; the count of the rest is recorded. Warnings about skipped entries stay with their scope until it is captured again.

A checkpoint whose row was saved just before a crash or a Cancel is kept: re-entering that visit reuses it instead of capturing again, and a cancelled run keeps it as history.

## Retention

Checkpoint records and their saved file bytes are kept until the project is deleted. Saved bytes can still go missing or be corrupted on disk; opening a file is what discovers that, and its metadata stays readable.
