# Execution Model

**Last updated:** 2026-03-31

This document defines runtime execution behavior for tasks, sessions, and git-backed environments in the active MVP.

System boundaries and deployment modes are defined in `docs/architecture/system-architecture.md`.

## Path conventions

`project root` means the git repo root registered as a project in Isagi and visible to the active backend filesystem.

`worktree root` means the Isagi-controlled root where managed git worktrees live.

`execution root` means the filesystem root currently bound to a session process.

`repo-key` means a stable filesystem-safe identifier derived from the registered project/repo identity for managed worktree naming.

`branch-slug` means a normalized filesystem-safe representation of the branch name for managed worktree naming.

Conventions:

- projects remain in their existing repo locations; Isagi does not redefine their canonical location
- managed worktrees live under `worktree root`, not inside the registered project repo
- each session is bound to one execution root for its lifetime
- git naming/default rules are defined in `docs/product/config/project-task-git-rules.md`

## Workspace layout (v1)

Isagi metadata and managed worktrees live under Isagi-controlled paths, while projects remain where they already exist on disk relative to the active backend.

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
- the same conceptual layout applies whether the backend runs locally or remotely

## Execution root defaults

Task-linked sessions inherit one guaranteed starting context: the task's project repo root.

Scratch sessions inherit one guaranteed starting context: the selected project's repo root.

Shaping sessions inherit one guaranteed starting context: the selected project's repo root.

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
- Task-linked sessions belong to tasks.
- Scratch sessions are project-scoped exploration sessions with no task and no backlog/accountability object.
- Shaping sessions are tracked project-scoped backlog-shaping sessions with no task.
- A task does not carry an immutable branch or worktree assignment.
- Multiple sessions under the same task may operate on different branches or roots.
- Outputs live in code, documents, and other filesystem changes, not in the session object itself.

## Session lifecycle and states

- Task-linked sessions are created by opening a task or by starting a task-backed ad-hoc session that auto-creates a visible task.
- Scratch sessions are created by explicitly starting a scratch session against a selected project.
- Shaping sessions are created by explicitly starting or resuming a project-scoped shaping session against a selected project.
- Task-linked sessions can remain attached to a task across multiple resumptions as long as the execution directory does not change.
- Scratch sessions can remain attached to their project context across multiple resumptions as long as the execution directory does not change.
- Shaping sessions can remain attached to their project context across multiple resumptions as long as the execution directory does not change.
- Shaping sessions may stage accepted and rejected backlog proposals until the session is finalized and closed.
- Sessions can be manually closed.
- Task-linked sessions auto-close when the parent task enters a `done`-bucket status.
- Scratch sessions do not auto-close from task status because they have no task.
- Shaping sessions do not auto-close from task status because they have no task.
- Some session records may later be archived when a project-level mutation invalidates their prior repo context, such as a repo-path change.

Session states:

- `active` - the agent is processing
- `idle` - the agent is waiting on the user
- `closed` - the session is intentionally no longer active
- `archived` - the session is retained as historical record only and cannot be resumed because its prior repo binding is no longer considered live
- `error` - hidden technical failure state for start, resume, or execution-root-change issues

Notes:

- `closed` and `archived` are both non-active states, but they differ in cause.
- `closed` is the normal end state for a session the user or system no longer keeps active.
- `archived` is a non-resumable preservation state used when a higher-level change, such as a repo-path change, makes the old execution context invalid.
- Implementations may store a `close_reason` or equivalent field to distinguish causes such as manual close, task completion, or execution-root change.
- Repo-path-change semantics are defined canonically in `docs/product/config/project-task-git-rules.md`.

## Execution root changes

- Users may change branch or switch to/from a managed worktree during work.
- Branch and worktree controls are user-driven and happen at the user's risk.
- A session is directory-bound for its lifetime.
- If the execution root path changes, Isagi closes the current session and creates a new session bound to the new directory.
- Because execution-root changes end the current session, the product should treat them as warning-worthy transitions rather than invisible rebinding.
- For task-linked sessions, the replacement session stays under the same task.
- For scratch sessions, the replacement session stays in the same project-scoped scratch lane.
- For shaping sessions, the replacement session stays in the same project-scoped shaping lane.
- If the user wants a separate execution thread without closing the current session, they should create a separate session directly.

## Managed worktree behavior

- Worktree creation is automated when `managed_worktree` is chosen.
- Managed worktrees live under `worktree root`.
- Switching from a repo root into a managed worktree, or between worktrees, creates a new session because the execution directory changes.
- Merge remains a manual activity assisted by UI/actions, not an automatic side effect of task or session completion.
- Worktree deletion also remains manual in v0.
- If worktree creation or execution-root change fails, the session may enter `error` until the user retries or selects a different execution root.

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

These passive snapshots apply to task-linked, scratch, and shaping sessions.

## Collision awareness

- Isagi warns when multiple sessions share the same execution directory.
- The recent-activity window is an implementation-configurable heuristic rather than a fixed product invariant.
- Warnings consider:
  - `active` sessions
  - `idle` sessions that are still within the recent-activity window
- `closed` sessions are excluded.
- `archived` sessions are also excluded.
- Warnings are advisory and do not hard-block user actions.
- Task and session surfaces should expose read-only visibility such as overlapping sessions, active session counts, or last known execution roots where useful.
- Scratch sessions participate in the same directory-level warning model as task-linked sessions.
- Shaping sessions also participate in that same directory-level warning model.

## Task status interaction

- Task status remains manual in v0.
- Project-specific statuses map to the global buckets `todo`, `in_progress`, and `done`.
- Entering a `done`-bucket status is the terminal close event for that task's task-linked sessions.
- Runtime closure is driven by status transition rather than a distinct `Complete task` action.
- Scratch sessions are unaffected by task status because they are not task-backed.
- Shaping sessions are also unaffected by task status because they are not task-backed.

## Out-of-scope for MVP

- Full in-app PR lifecycle management.
- Automatic merge on status-driven task or session closure.
- Automatic worktree deletion based on remote merge detection.
- Hard locking of branches or directories.
- Project-group / multi-repo orchestration.
- Release/deploy orchestration.
