# Isagi - mental model

**Last updated:** 2026-03-31

This document defines the core concepts and invariants for the active MVP.

## Glossary

### Project

A project is an existing git repo registered in Isagi through a repo path visible to the active backend.

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
- remain the canonical actionable unit even when a project uses project-local terminology in the UI
- are execution-agnostic

Canonical task contract: `docs/product/task-model.md`.

### Session

A session is an execution surface inside a project.

Sessions:

- come in three MVP forms:
  - task-linked sessions for accountable tracked work
  - project-scoped scratch sessions for quick exploration or Q&A
  - project-scoped shaping sessions for tracked backlog-shaping work without a task
- are where agent work happens
- can start in the project repo or a managed worktree
- are bound to one execution directory for their lifetime
- map 1:1 to one underlying harness session
- are not the durable output themselves

### Shaper agent

The Shaper agent is a project-scoped backlog-shaping agent launched by actions such as `Shape what's next`.

Shaper sessions:

- turn fuzzy project intent into accountable backlog work
- primarily draft task proposals in the shaping companion panel
- may still drive collection creation or broader backlog cleanup outcomes through the conversation itself
- run as tracked project-scoped shaping sessions rather than task-linked sessions
- remain resumable but do not appear as tasks on project boards

### Spark

A spark is a deferred Phase 2 raw global inbox capture concept.

The first MVP release does not depend on sparks. They may return later as a backlog-feeding companion to the active core model.

### Worktree

A worktree is an optional git execution environment used by a session.

Managed worktrees are created automatically when chosen, but merge and deletion remain manual in v0.

### Legacy term: Area

Earlier drafts used `Area` as a core primitive. The active MVP no longer depends on area-first modeling.

---

## Core invariants

1. **Every project is an existing git repo visible to the active backend.**
2. **Every task belongs to exactly one project.**
3. **A task may belong to zero or one collection inside that project.**
4. **Tasks never move between projects.** Archive and recreate instead.
5. **Sessions come in three kinds.** A session is task-linked, project-scoped scratch, or project-scoped shaping.
6. **Every task-linked session belongs to exactly one task.** Ad-hoc tracked work auto-creates visible tasks.
7. **Scratch sessions belong to a project, not a task or collection.** They are intentionally outside backlog accountability.
8. **Shaping sessions also belong to a project, not a task or collection.** They are tracked proposal workspaces rather than execution tasks.
9. **Sessions never belong directly to collections.**
10. **Tasks are execution-agnostic.** Branch and worktree choices are execution strategy, not task identity.
11. **Task status is manual and intrinsic to the task.** Project-specific statuses map to global buckets: `todo`, `in_progress`, `done`.
12. **Every Isagi session maps 1:1 to one harness session.** Isagi owns the product abstraction, but the underlying execution session remains singular.
13. **Sessions are directory-bound.** If execution moves to a different directory, the current session closes and a new session is created instead of rebinding the same session.
14. **Task closure is status-driven for task-linked sessions only.** Moving a task into a `done`-bucket status closes its task-linked sessions; MVP surfaces do not expose a second completion action separate from status.
15. **No subtasks in v0.** Review and handoff stay on the same task via status or assignment changes.

## Active MVP posture

The active MVP keeps tasks as the canonical accountable unit for execution work while also supporting a separate project-scoped shaping lane:

- projects provide repo context
- collections optionally group related tasks
- tasks remain the canonical actionable unit for accountable execution work
- shaping sessions remain tracked project-scoped proposal workspaces rather than tasks
- sessions do the execution and shaping work
- sparks remain useful for backlog health, but do not gate task creation

Read together:

- `docs/product/collection-model.md`
- `docs/product/task-model.md`
- `docs/architecture/execution-model.md`
- `docs/product/config/project-task-git-rules.md`

---

## Execution posture

- Task-backed sessions inherit the task's project repo root.
- Scratch and shaping sessions inherit the selected project's repo root.
- Sessions may move work to a different valid execution root, but doing so closes the current session and creates a new one.
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
- Home may surface task sessions, scratch sessions, and shaping sessions.
- Scratch sessions should be visibly marked as scratch.
- Shaping sessions should be visibly marked as shaping.
- Home may show lightweight fallback tasks only when there is no session to resume.
- Home is not the primary place for deliberate task browsing or project management.

Detailed Home-screen guidance lives in `docs/product/screens/home-screen.md`.

Project Detail is the deliberate project/backlog surface for one repo project.

- Project Detail is where the user inspects project work shape, organizes backlog, and picks the next actionable task.
- Detailed Project Detail guidance lives in `docs/product/screens/project-detail-screen.md`.
- Detailed execution-surface guidance lives in `docs/product/screens/session-screen.md`.

Focus remains task-centered for execution work while keeping project-scoped session lanes visible elsewhere in the product:

- active and idle task-linked sessions remain visible on tasks
- scratch and shaping sessions remain visible from Home and the sidebar rather than on boards
- directory-level collision warnings help avoid accidental overlap
- review and handoff stay attached to the same task rather than spawning subtasks

---

## What remains intentionally flexible

- Phase 2 spark inbox / spark-triage design
- project-local terminology for presentation (configuration details live in `docs/product/config/project-task-git-rules.md`)
- collection-centric views and grouping behavior
- status-change automation hooks
- how shaping sessions materialize accepted task proposals
- roll-up portfolios / project-group support for multi-repo work
- whether a separate durable artifact subsystem returns later
