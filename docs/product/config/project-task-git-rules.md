# Project/Task Git Rules

**Last updated:** 2026-03-11

This document defines configuration-level git defaults for project-scoped tasks and sessions.

## One-liner

Projects define the repo context and default git mode; sessions decide how work is executed inside that project.

## Project model

- A project points at an existing local git repo.
- Project registration should validate that the configured path is already a git repo.
- Project registration requires only a project name and repo path.
- Other project configuration remains optional after registration.
- Project IDs should be stable and filesystem-safe.
- Repo path is stored separately from project identity.
- Projects may define optional collections for grouping work, but the repo project remains the execution container.
- Tasks inherit the project repo root as their default execution context.
- Collections do not redefine execution root.

## Display aliases

- Projects may define project-local UI terminology aliases for visible model terms such as `collection`, `task`, or other workflow-facing labels.
- These terminology aliases are distinct from task `labels` metadata.
- Aliases are presentation-only and do not rename canonical model terms in docs or contracts.
- Aliases do not change task ownership, session ownership, status semantics, or execution behavior.

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
- optional collection definitions
- project-defined task statuses mapped to global buckets
- optional display aliases for project-local terminology
- optional saved-view definitions and last-used view state
- optional default task labels or related workflow metadata

## Deferred extension points

- project groups / multi-repo execution
- roll-up / portfolio projects
- stricter merge or cleanup enforcement
- status-change automation hooks
- richer project-level agent guidance projections
