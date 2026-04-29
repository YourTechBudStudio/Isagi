# Project Git Rules

**Last updated:** 2026-04-28

This document defines configuration-level git defaults for project-scoped sessions.

## One-liner

Projects define the MVP repo context and default git mode; sessions decide how work is executed inside that project.

## Project model

- In the MVP, a project points at one existing git repo visible to the active backend filesystem.
- Project registration should validate that the configured path is already a git repo.
- Project registration is repo-first: the user selects or enters a backend-visible repo directory, then confirms a project name.
- Other project configuration remains optional after registration.
- Milestones group planning work, but do not redefine execution root.
- Tasks inherit the project repo root as their default execution context.
- Scratch, Discovery, and Shaping sessions inherit the selected project's repo root because they are project-scoped.

Canonical registration guidance lives in `docs/product/screens/project-registration-flow.md`.

## Git-backed config

Project configuration should be Git-backed where practical, likely under `.isagi/config/`.

This may include statuses, prompt/template configuration, or other project conventions. Exact config files are intentionally deferred.

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
- project git mode may fall back to the global default
- task creation should not require choosing a git mode
- session start may override the default when the user wants a different execution strategy

## Project-defined statuses

- Projects define their own ordered statuses.
- Each status maps to one global group:
  - `To-do`
  - `In progress`
  - `Done`
- Status order can shape grouped ordering in list or board views.
- Phase 1 excludes status automation hooks and rule-based transitions.
- Status config should be rebuildable from project files where practical.
- Task artifact status should live in frontmatter; project status definitions should live under `.isagi/config/` where practical.

## Managed worktree rules

- Managed worktrees are created automatically when selected.
- Worktrees live under the Isagi worktree root, not inside the project repo.
- Merge remains manual.
- Worktree deletion remains manual in v0.

## Session execution rules

- Sessions may stay on the current branch or move to a managed worktree.
- Sessions may switch execution root during work.
- Sessions are directory-bound; if execution root changes, the current session is closed and a new session is created.
- A task may end up with multiple sessions using different roots at the user's discretion.
- Replacement sessions created by execution-root changes stay in the same project context.
- Canonical runtime behavior lives in `docs/architecture/execution-model.md`.

## Repo-path changes

- A project's repo path / repo reference may be editable after registration.
- Changing the repo path is a high-risk project-level mutation.
- Existing sessions tied to the prior repo path should be archived or otherwise made non-resumable.
- Planning artifacts remain project files and should be handled explicitly during any repo-path change.

## Collision warnings

- Warn when another active or recent idle session shares the same execution directory.
- Exclude closed sessions from collision checks.
- Keep warnings advisory rather than blocking.
- Surface overlapping sessions and related execution roots as read-only visibility where useful.

## Deferred extension points

- multi-repo projects
- stricter merge or cleanup enforcement
- status-change automation hooks
- exact `.isagi/config/` file formats
