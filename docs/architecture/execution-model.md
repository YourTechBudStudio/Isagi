# Execution Model

**Last updated:** 2026-03-06

This document defines runtime execution behavior for tasks, sessions, and git-backed environments in the task-first MVP.

## Path conventions

`project root` means the local git repo root registered as a project in Isagi.

`worktree root` means the workspace-sibling root where Isagi-managed git worktrees live.

`execution root` means the filesystem root currently bound to a session process.

`repo-key` means a stable filesystem-safe identifier derived from the registered project/repo identity for managed worktree naming.

`branch-slug` means a normalized filesystem-safe representation of the branch name for managed worktree naming.

Conventions:

- projects remain in their existing local paths; Isagi does not redefine their canonical location
- managed worktrees live under `worktree root`, not inside the registered project repo
- sessions can move between execution roots over time
- git naming/default rules are defined in `docs/product/config/project-task-git-rules.md`

## Workspace layout (v1)

Isagi metadata and managed worktrees live under Isagi-controlled paths, while projects remain where they already exist on disk.

Conceptual layout:

```txt
isagi-root/
  data/
  worktrees/
    <repo-key>-<branch-slug>/
```

Remarks:

- project repos themselves are not copied into `isagi-root/`
- managed worktrees are physically created under `worktree root`
- execution root determines the working directory for the current session process

## Execution root defaults

Every session attached to a task inherits one guaranteed starting context: the task's project repo root.

Git mode selection resolves in this order:

1. explicit session choice
2. project default
3. global default

Supported modes:

- `same_branch`
- `managed_worktree`
- `ask_each_time`

Initial global default is `same_branch`.

Project default is nullable and falls back to the global default.

Other task or project metadata may be shown in side panels as view-only context, but only the project repo root is guaranteed runtime inheritance in v0.

## Task/session relationship

- Task owns planning and accountability.
- Session owns execution context.
- A task does not carry an immutable branch or worktree assignment.
- Multiple sessions under the same task may operate on different branches or roots.
- Outputs live in code, documents, and other filesystem changes, not in the session object itself.

## Session lifecycle and states

- Sessions are created by opening a task or by starting an ad-hoc session that auto-creates a visible task.
- Sessions can remain attached to a task across multiple resumptions.
- Sessions can be manually closed.
- Sessions auto-close when the parent task enters a `done`-bucket status.

Session states:

- `active` - the agent is processing
- `idle` - the agent is waiting on the user
- `closed` - the session is intentionally no longer active
- `error` - hidden technical failure state for start/rebind issues

## Execution root switches and rebind

- Users may change branch or switch to/from a managed worktree during a session.
- Branch/worktree controls are user-driven and happen at the user's risk.
- If the execution root path changes, Isagi rebinds the same session to the new root.
- Rebind may start a new backend process, but the conversation/session identity stays the same.
- If the user wants a separate execution thread, they should create a separate session instead of rebinding the existing one.

## Managed worktree behavior

- Worktree creation is automated when `managed_worktree` is chosen.
- Managed worktrees live under `worktree root`.
- Merge remains a manual activity assisted by UI/actions, not an automatic side effect of task or session completion.
- Worktree deletion also remains manual in v0.
- If worktree creation or rebind fails, the session may enter `error` until the user retries or selects a different execution root.

## Passive execution snapshots

On each user request in a session:

- observe the current execution root and branch name
- compare against the previous snapshot for that session
- persist a new snapshot only when one of those values changed

Implementations may also store supporting fields such as:

- timestamp
- repo identifier
- `is_worktree`
- trigger source

External git changes between user requests are intentionally only captured on the next interaction.

## Collision awareness

- Isagi warns when multiple sessions share the same execution directory.
- The recent-activity window is an implementation-configurable heuristic rather than a fixed product invariant.
- Warnings consider:
  - `active` sessions
  - `idle` sessions that are still within the recent-activity window
- `closed` sessions are excluded.
- Warnings are advisory and do not hard-block user actions.
- Task and session surfaces should expose read-only visibility such as overlapping sessions, active session counts, or last known execution roots where useful.

## Task status interaction

- Task status remains manual in v0.
- Project-specific statuses map to the global buckets `todo`, `in_progress`, and `done`.
- Entering a `done`-bucket status is the terminal close event for that task's sessions.

## Out-of-scope for MVP

- Full in-app PR lifecycle management.
- Automatic merge on task or session completion.
- Automatic worktree deletion based on remote merge detection.
- Hard locking of branches or directories.
- Project-group / multi-repo orchestration.
- Release/deploy orchestration.
