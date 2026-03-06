# Isagi - mental model

**Last updated:** 2026-03-06

This document defines the core concepts and invariants for the active MVP.

## Glossary

### Project

A project is an existing local git repo registered in Isagi.

Projects:

- own tasks
- define customizable task statuses
- can carry project-level git execution defaults

### Task

A task is the smallest accountable unit of outcome inside a project.

Tasks:

- belong to exactly one project
- track intent and progress
- can have multiple sessions
- are execution-agnostic

Canonical task contract: `docs/product/task-model.md`.

### Session

A session is the execution surface attached to a task.

Sessions:

- are where agent work happens
- can start in the project repo or a managed worktree
- can be rebound to a different execution root during work
- are not the durable output themselves

### Spark

A spark is a deferred Phase 2 raw global inbox capture concept.

The first MVP release does not depend on sparks. They may return later as a backlog-feeding companion to the task-first core.

### Worktree

A worktree is an optional git execution environment used by a session.

Managed worktrees are created automatically when chosen, but merge and deletion remain manual in v0.

### Resource (deferred)

`Resource` remains a deferred durable-output concept from earlier drafts. It is not part of the active task-first v0 core.

Reference: `docs/architecture/resources-model.md`.

### Legacy term: Area

Earlier drafts used `Area` as a core primitive. The active MVP no longer depends on area-first modeling.

---

## Core invariants

1. **Every task belongs to exactly one project.**
2. **Tasks never move between projects.** Archive and recreate instead.
3. **Every session belongs to a task.** Ad-hoc sessions auto-create visible tasks.
4. **Tasks are execution-agnostic.** Branch and worktree choices are execution strategy, not task identity.
5. **Task status is manual.** Project-specific statuses map to global buckets: `todo`, `in_progress`, `done`.
6. **Sessions may change execution root during work.** Git controls are user-driven and warning-based, not hard-locked.
7. **Task closure is status-driven.** Moving a task into a `done`-bucket status closes its sessions.
8. **No subtasks in v0.** Review and handoff stay on the same task via status or assignment changes.

## Task-first MVP posture

The active MVP is task-first:

- projects provide repo context
- tasks track accountability and progress
- sessions do the execution work
- sparks remain useful for backlog health, but do not gate task creation

Read together:

- `docs/product/task-model.md`
- `docs/architecture/execution-model.md`
- `docs/product/config/project-task-git-rules.md`

---

## Execution posture

- The only guaranteed inherited execution context is the task's project repo root.
- Sessions may rebind to managed worktrees or other valid roots while preserving the same conversation identity.
- Project-level git mode defaults can shape how sessions start, but sessions remain user-driven.
- The system records passive execution snapshots and surfaces collision warnings when multiple recent sessions share a directory.

Runtime mechanics are canonical in `docs/architecture/execution-model.md`.

---

## Spark posture

- Spark capture and spark triage are deferred to Phase 2.
- The first MVP release does not depend on a spark inbox.
- If reintroduced later, sparks should act as backlog feeders rather than the mandatory start of work.

Guidance projection ideas live in `docs/product/config/agent-guidance-projections.md`.

---

## Home and focus model (desktop-first)

Home/dashboard prioritizes:

1. recent sessions to resume
2. task list / focus queue

Focus remains task-first with session-level visibility:

- active and idle sessions remain visible on tasks
- directory-level collision warnings help avoid accidental overlap
- review and handoff stay attached to the same task rather than spawning subtasks

---

## What remains intentionally flexible

- Phase 2 spark inbox / spark-triage design
- status-change automation hooks
- planner-assisted task creation
- project-group support for multi-repo work
- whether the deferred resources model returns as an active subsystem
