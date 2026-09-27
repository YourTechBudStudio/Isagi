# Place workflow checkpoints

A checkpoint preserves declared files from the run's destination plus its current Git commit, when available. It supports fresh filesystem reconstruction. Graph state, execution position, agent sessions, terminals, and processes are not restored.

## Choose the boundary

Place checkpoints after meaningful completion or approval, before useful files are overwritten/deleted, and at the end of a run. Finish every writer before capture: wait for agent turns, headless work, and commands touching the scopes. Observable concurrent changes cause capture to fail; this is not an atomic filesystem snapshot.

Phase directories make document handoffs easier to capture, for example `work/research` and `work/design`. Use this when useful; source files may remain scattered. Exclude secrets, dependencies, caches, and unnecessary generated bulk. Ignored files inside a scope are captured too. There is no byte or file-count cap.

## Declare the node

```ts
import { checkpoint } from '@yourtechbudstudio/isagi-workflow-sdk';

type State = { readonly phase: number };

export const savePhase = checkpoint<State>({
  title: 'Save approved phase',
  prepare: (state) => ({
    title: `Phase ${state.phase} saved`,
    capture: [
      { scope: `phase-${state.phase}`, directory: `work/phase-${state.phase}` },
      { scope: 'decisions', file: 'decisions.md' },
    ],
  }),
});
```

Register one outgoing edge, as for an operation; the checkpoint leaves graph state unchanged. `prepare(state)` is pure and synchronous, and runs only when visited. Consult the installed SDK's `checkpoints.d.ts` and `nodes.d.ts` for fields and limits.

Paths are relative to the destination worktree/folder root, using `/`; absolute paths, traversal, and `.git` paths are rejected. Directory scopes accept scope-relative `exclude` paths, without globs. Scopes in one plan cannot overlap. An empty capture list records the baseline and inherits earlier captures.

## Inheritance and deletion

Every checkpoint layers onto the run's previous checkpoint, including captures from nested graphs. Omitted scopes keep their earlier saved content. Recaptured scopes reflect current additions, changes, deletions, and exclusions.

A scope ID identifies the same path and kind throughout the run. Use a new ID for a different path; exclusions may change. Across checkpoints, a wider scope replaces narrower regions inside it, while a narrower scope replaces only its own region.

To preserve a deletion, recapture that scope after deleting the file. A missing path is accepted as empty only if that exact path was previously covered or is tracked in the baseline; otherwise it fails as a likely typo. Omitting a scope never deletes its saved content. Inherited files changed or deleted on disk need recapture to update their saved state.

## Coverage and limitations

Git reconstruction starts at the selected checkpoint's own commit and applies captured files and required absences. The baseline includes committed content; staged, unstaged, untracked, ignored changes and uncommitted deletions need explicit scopes. Review `uncaptured_dirty_path` warnings and widen scopes when the missing work matters. Ignored paths outside scopes are not surveyed.

Symlinks and special files are skipped and left to the baseline; a symlink scope root is rejected. Nested `.git` entries are skipped. Use exact path spelling, including case. File/directory kind changes must be committed before capture.

Isagi records the commit without retaining a Git ref. If that commit or repository disappears, Git export fails; metadata and saved content remain inspectable. Folder projects and repositories with no commits reconstruct only captured files into an empty folder.

## Diagnose capture failures

A refused capture saves no checkpoint. Inspect the failed attempt's `detail.reason`, fix the cause, then Retry. Common causes are a missing/misspelled path, a reused scope ID naming another path/kind, overlapping scopes, or writers/HEAD changing during capture. `prepare` must return a valid plan synchronously.

Warnings describe a saved checkpoint's incomplete coverage; they are not capture failures. Inspect skipped paths, dirty paths, and empty recaptures before relying on reconstruction. A checkpoint already saved before interruption is reused on re-entry.

There is no automatic retention cap; cancellation, detachment, and worktree removal preserve captures. Explicit project deletion is the separate retention boundary. Content reads can still discover missing or corrupt bytes.

To inspect coverage, export, and launch a fresh run, use [CLI reconstruction](cli-reconstruct-and-launch.md).
