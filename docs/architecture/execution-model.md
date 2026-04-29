# Execution Model

**Last updated:** 2026-04-28

This document defines runtime execution behavior for sessions and git-backed environments in the active MVP.

System boundaries live in `docs/architecture/system-architecture.md`. Planning artifact semantics live in `docs/product/planning-artifacts.md`.

## Path conventions

`project root` means the git repo root registered as a project in Isagi and visible to the active backend filesystem.

`worktree root` means the Isagi-controlled root where managed git worktrees live.

`execution root` means the filesystem root currently bound to a session process.

## Execution root defaults

- Task-linked sessions start from the task's project repo root unless the user selects another execution strategy.
- Scratch, Discovery, and Shaping sessions start from the selected project's repo root.
- Git mode selection resolves from explicit session choice, then project default, then global default.

Supported modes:

- `same_branch`
- `managed_worktree`
- `ask_each_time`

## Task/session relationship

- Planning artifacts live in project files under `.isagi/`.
- Sessions own live runtime execution context.
- Task-linked sessions attach execution work to a task artifact.
- Scratch sessions explore project context without requiring a task.
- Discovery sessions help find or confirm the next milestone.
- Shaping sessions help turn a milestone into task artifacts.
- A task does not carry an immutable branch or worktree assignment.
- Multiple sessions under the same task may operate on different branches or roots.

## Session lifecycle and states

- Sessions are created by starting task execution, scratch exploration, Discovery, or Shaping.
- Sessions can be resumed as long as their backend/harness session binding remains valid.
- Sessions can be manually closed.
- Task-linked sessions may close when the parent task reaches a status mapped to `Done`.
- Some session records may be archived when a project-level mutation invalidates their prior repo context.

Session states:

- `active` - the agent is processing
- `idle` - the agent is waiting on the user
- `closed` - the session is intentionally no longer active
- `archived` - the session is retained as historical record only and cannot be resumed
- `error` - technical failure state for start, resume, or execution-root-change issues

## Execution root changes

- Users may change branch or switch to/from a managed worktree during work.
- Branch and worktree controls are user-driven.
- A session is directory-bound for its lifetime.
- If the execution root path changes, Isagi closes the current session and creates a new session bound to the new directory.
- Execution-root changes should be warning-worthy transitions rather than invisible rebinding.

## Managed worktree behavior

- Worktree creation is automated when `managed_worktree` is chosen.
- Managed worktrees live under `worktree root`.
- Switching from a repo root into a managed worktree, or between worktrees, creates a new session because the execution directory changes.
- Merge remains manual.
- Worktree deletion remains manual in v0.

## Passive execution snapshots

On each user request in a session, Isagi may observe the current execution root and branch name and persist a new runtime snapshot when those values change.

These snapshots are backend-owned runtime metadata, not durable planning artifacts.

## Collision awareness

- Isagi warns when multiple active or recent idle sessions share the same execution directory.
- Closed and archived sessions are excluded.
- Warnings are advisory and do not hard-block user actions.
- Task and session surfaces may expose read-only visibility such as overlapping sessions, active session counts, or last known execution roots.

## Task status interaction

- Task status remains manual in v0.
- Project-specific statuses map to `To-do`, `In progress`, or `Done`.
- Entering a status mapped to `Done` may close task-linked sessions.
- Runtime closure is driven by status transition rather than a distinct `Complete task` action.

## Out-of-scope for MVP

- Full in-app PR lifecycle management.
- Automatic merge on status-driven task or session closure.
- Automatic worktree deletion based on remote merge detection.
- Hard locking of branches or directories.
- Multi-repo project orchestration.
- Release/deploy orchestration.
