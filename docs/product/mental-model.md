# Isagi - mental model

**Last updated:** 2026-03-10

This document defines the core concepts and invariants for the active MVP.

## Glossary

### Project

A project is an existing local git repo registered in Isagi.

Projects:

- own tasks and optional collections
- define customizable task statuses
- can carry project-level git execution defaults

### Collection

A collection is an optional grouping container inside a single project.

Collections:

- organize related tasks around a broader outcome
- belong to exactly one project
- do not own execution context
- do not receive sessions directly

Canonical collection contract: `docs/product/collection-model.md`.

### Task

A task is the smallest accountable unit of outcome inside a project.

Tasks:

- belong to exactly one project
- may optionally belong to one collection in that project
- track intent and progress
- can have multiple sessions
- remain the canonical actionable unit even when a project uses aliases in the UI
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

1. **Every project is an existing local git repo.**
2. **Every task belongs to exactly one project.**
3. **A task may belong to zero or one collection inside that project.**
4. **Tasks never move between projects.** Archive and recreate instead.
5. **Every session belongs to a task.** Ad-hoc sessions auto-create visible tasks, and planning flows do the same or resume a dedicated planning task.
6. **Sessions never belong directly to collections.**
7. **Tasks are execution-agnostic.** Branch and worktree choices are execution strategy, not task identity.
8. **Task status is manual and intrinsic to the task.** Project-specific statuses map to global buckets: `todo`, `in_progress`, `done`.
9. **Sessions may change execution root during work.** Git controls are user-driven and warning-based, not hard-locked.
10. **Task closure is status-driven.** Moving a task into a `done`-bucket status closes its sessions; MVP surfaces do not expose a second completion action separate from status.
11. **No subtasks in v0.** Review and handoff stay on the same task via status or assignment changes.

## Task-first MVP posture

The active MVP is task-first:

- projects provide repo context
- collections optionally group related tasks
- tasks remain the canonical actionable unit for accountability and progress
- sessions do the execution work
- sparks remain useful for backlog health, but do not gate task creation

Read together:

- `docs/product/collection-model.md`
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

Home is a minimal global re-entry surface.

- Home prioritizes resumable sessions first.
- Home may show lightweight fallback tasks only when there is no session to resume.
- Home is not the primary place for deliberate task browsing or project management.

Detailed Home-screen guidance lives in `docs/product/screens/home-screen.md`.

Project Detail is the deliberate project/backlog surface for one repo project.

- Project Detail is where the user inspects project work shape, organizes backlog, and picks the next actionable task.
- Detailed Project Detail guidance lives in `docs/product/screens/project-detail-screen.md`.
- Detailed execution-surface guidance lives in `docs/product/screens/session-screen.md`.

Focus remains task-first with session-level visibility elsewhere in the product:

- active and idle sessions remain visible on tasks
- directory-level collision warnings help avoid accidental overlap
- review and handoff stay attached to the same task rather than spawning subtasks

---

## What remains intentionally flexible

- Phase 2 spark inbox / spark-triage design
- project-local aliases for presentation (configuration details live in `docs/product/config/project-task-git-rules.md`)
- collection-centric views and grouping behavior
- status-change automation hooks
- planner-assisted task creation
- roll-up portfolios / project-group support for multi-repo work
- whether the deferred resources model returns as an active subsystem
