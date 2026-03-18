# Project/Task Git Rules

**Last updated:** 2026-03-17

This document defines configuration-level git defaults for project-scoped tasks and sessions.

## One-liner

Projects define the repo context and default git mode; sessions decide how work is executed inside that project.

## Project model

- A project points at an existing local git repo.
- Project registration should validate that the configured path is already a git repo.
- Project registration is repo-first: the user selects or pastes a local repo directory, then confirms an inferred editable project name.
- Other project configuration remains optional after registration.
- Project IDs should be stable and filesystem-safe.
- Repo path is stored separately from project identity.
- Projects may define optional collections for grouping work, but the repo project remains the execution container.
- Tasks inherit the project repo root as their default execution context.
- Scratch and shaping sessions inherit the selected project's repo root directly because they are project-scoped rather than task-backed.
- Collections do not redefine execution root.
- Canonical registration-flow guidance lives in `docs/product/screens/project-registration-flow.md`.

## Terminology

- Projects may define project-local UI terminology labels for visible model terms such as `task` and `collection`.
- These terminology labels are distinct from task `labels` metadata.
- Terminology is presentation-only and does not rename canonical model terms in docs or contracts.
- Terminology does not change task ownership, session ownership, status semantics, or execution behavior.
- `Task label` remains a UI-only label.
- `Collection label` defaults to `Milestone` in the UI.
- Phase 1 still exposes one collection concept to the user.
- Internally, a project may carry one default collection-kind definition for forward compatibility with multiple collection kinds later; this simply means one project-owned definition for the single collection concept exposed in the MVP UI.
- That forward-compatible implementation detail does not change the Phase 1 user-facing model.

## Saved views

- Projects may define saved views for project-detail task surfaces.
- A new project starts with default **Board** and **List** views.
- Users may edit, delete, or create additional views over time.
- Saved view config may control layout, grouping, filters, and sorting.
- Phase 1 layout options are:
  - `list`
  - `kanban`
- Phase 1 grouping options are:
  - `status`
  - `label`
  - `collection`
  - `none`
- Phase 1 sorting options are:
  - `due_date`
  - `priority`
  - `updated_at`
  - `created_at`
- Phase 1 filter fields are:
  - `status`
  - `priority`
  - `label`
  - `collection`
  - `due_date`
- Filters operate over task metadata.
- The product should remember the last-used view per project.
- View config affects presentation only; it does not change task ownership, task status semantics, or execution behavior.
- Phase 1 explicitly excludes calendar layout, formulas/computed fields, and cross-project views.

## Git mode defaults

Supported modes:

- `same_branch`
- `managed_worktree`
- `ask_each_time`

Resolver hierarchy:

1. explicit session choice
2. project default
3. global default

Rules:

- initial global default is `same_branch`
- project git mode is nullable and falls back to the global default
- task creation should not require choosing a git mode
- session start may override the default when the user wants a different execution strategy
- The global default is product-level configuration even though its dedicated configuration surface is outside the current screen-doc set.

## Project-defined task statuses

- Projects define their own ordered task statuses.
- Each status maps to a global bucket:
  - `todo`
  - `in_progress`
  - `done`
- Status order is meaningful in Phase 1:
  - it expresses expected workflow progression posture
  - it determines grouped ordering in list and kanban views when grouped by status
- Phase 1 status config may support create/edit/delete/reorder behavior.
- Phase 1 excludes status automation hooks and rule-based transitions.

## Managed worktree rules

- Managed worktrees are created automatically when selected.
- Worktrees live under the Isagi worktree root, not inside the project repo.
- `repo-key` is a stable filesystem-safe identifier derived from the registered project/repo identity.
- `branch-slug` is a normalized filesystem-safe version of the branch name used in worktree paths.
- Path naming should use normalized `repo-key` and `branch-slug` segments.
- Merge remains manual.
- Worktree deletion remains manual in v0.

## Session execution rules

- Sessions may stay on the current branch or move to a managed worktree.
- Sessions may switch execution root during work.
- If execution root changes, the same session is rebound rather than replaced.
- A task may end up with multiple sessions using different roots at the user's discretion.
- Scratch sessions use the same project/global git-mode resolver, git controls, and execution-root switching behavior as task-backed sessions.
- Scratch sessions differ only in not creating or attaching to a task.
- Shaping sessions use the same project/global git-mode resolver, git controls, and execution-root switching behavior as other sessions.
- Shaping sessions differ in being tracked and project-scoped without attaching to a task.
- Canonical shaping-session UI behavior lives in `docs/product/screens/session-screen.md` and `docs/product/screens/project-detail-screen.md`.

## Repo-path changes

- A project's repo path / repo reference is editable after registration.
- Changing the repo path is a high-risk project-level mutation.
- When the repo path changes:
  - existing sessions tied to the prior repo path are archived
  - archived sessions cannot be resumed
  - tasks remain project-owned and are not deleted by the repo-path change

## Collision warnings

- Warn when another `active` or idle-but-recent session shares the same execution directory.
- Exclude `closed` sessions from collision checks.
- Keep warnings advisory rather than blocking.
- Surface overlapping sessions and related execution roots as read-only visibility in task/session UI.

## Minimal project config fields

- `id`
- `name`
- repo path / repo reference
- nullable default git mode
- optional collection definitions and related project-owned collection data, without implying that collection-instance management belongs in Project Settings
- project-defined task statuses mapped to global buckets
- optional project terminology labels (`task`, `collection`)
- optional saved-view definitions and last-used view state
- optional default task labels or related workflow metadata

## Deferred extension points

- project groups / multi-repo execution
- roll-up / portfolio projects
- stricter merge or cleanup enforcement
- status-change automation hooks
- richer project-level agent guidance projections
