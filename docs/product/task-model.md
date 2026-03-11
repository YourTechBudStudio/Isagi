# Task Model (MVP)

**Last updated:** 2026-03-10

## One-liner

A task is the smallest accountable unit of outcome inside a project.

## Why task is the core unit

- Tasks hold planning and accountability without forcing a rigid workflow.
- Sessions do the work; tasks track what the work is, where it belongs, and how far it has moved.
- Tasks remain the canonical actionable unit even when a project uses workflow-specific status names or UI aliases.
- The MVP is optimized for low-overhead execution in existing local git repos, so task is the stable object around which sessions accumulate.

## Task definition

A task is a project-owned accountability object that tracks work intent and progress.

Tasks are execution-agnostic:

- a task is not a branch
- a task is not a worktree
- a task is not a session

Those are execution choices made while working on the task, not part of task identity itself.

## Task invariants

1. Every task belongs to exactly one project.
2. A task cannot move projects after creation.
3. A task may optionally belong to one collection in that project.
4. A task can have multiple sessions.
5. Sessions attach to tasks only.
6. No session is primary by default.
7. No subtasks exist in v0; review and handoff stay on the same task.
8. Task completion is status-driven; git cleanliness is not required in v0.
9. There is no standalone `Complete task` control distinct from task status in the MVP.

## Minimal schema

Required fields:

- `title`
- `project_id`
- `status`
- `created_at`
- `updated_at`

Optional fields:

- `collection_id` - nullable foreign key to a project-local collection
- `priority` - nullable enum: `p1 | p2 | p3 | p4 | p5`
- `labels` - nullable list or relation
- optional workflow metadata such as description, assignee, or reviewer

## Status model

- Statuses are customizable per project.
- Project-specific status vocabularies may diverge by workflow as long as each status maps to one global bucket.
- Every project status maps to one global bucket:
  - `todo`
  - `in_progress`
  - `done`
- Status remains intrinsic to the task rather than view-specific, roll-up-specific, or collection-specific.
- Moving a task into a `done`-bucket status is how the MVP treats the task as complete/closed.
- UI surfaces should complete or close tasks by updating status rather than introducing a separate `Complete task` command.
- Review, reassignment, and handoff are modeled as status or metadata changes on the same task.
- Future automation hooks may attach to status changes, but that behavior is deferred.

## Session relationship

- Every session belongs to a task.
- Sessions are the execution surfaces where agent work happens.
- Planning or organizing sessions still attach to tasks; project-level planning flows should create or resume a dedicated planning task rather than introducing a project-scoped session type.
- A task may accumulate multiple sessions for different kinds of work, such as implementation, review, or follow-up.
- Starting an ad-hoc session auto-creates a visible task with a generated title based on the first user message.
- Sessions auto-close when the parent task enters a terminal `done`-bucket status.

Detailed runtime behavior lives in `docs/architecture/execution-model.md`.

## Collection relationship

- A task may optionally belong to one collection in the same project.
- Collection membership groups related tasks around a broader outcome without changing task identity.
- Collection membership does not change execution-root inheritance, session ownership, or task status semantics.
- Canonical collection semantics live in `docs/product/collection-model.md`.

## Project relationship

- A project is an existing local git repo registered in Isagi.
- Tasks may live directly under the project or under an optional collection inside the project.
- The task inherits its project repo as the default execution context.
- Project-level git execution defaults can influence how sessions start, but they do not redefine task identity.

Project git rules are defined in `docs/product/config/project-task-git-rules.md`.

## What task is not

- not a branching strategy
- not a worktree lease
- not a durable output format
- not a subtask tree
- not a hardcoded workflow state machine

## Deferred / intentionally flexible

- task-status automation hooks
- spark inbox + spark-triage backlog feeder (Phase 2)
- planner-assisted task creation and decomposition
- richer team assignment policy
- stricter git-based completion rules
- project-group support for multi-repo execution
