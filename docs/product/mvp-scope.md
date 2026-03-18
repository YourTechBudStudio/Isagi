# MVP Scope (Phase 1)

**Codename:** Isagi  
**Legacy product name:** Spark System  
**Last updated:** 2026-03-17

This document defines what we are building for the MVP.

If anything else in `docs/` conflicts with this scope, **this document wins for MVP decisions**.

---

## Overview

Phase 1 is a **desktop-first task and session orchestration system for repo-based coding/product work**.

The MVP objective is to reduce activation energy and increase throughput by making project-scoped work easy to start, resume, and run in parallel with agent sessions.

The product remains ad-hoc: Isagi supports specialized workflows, but does not force one rigid workflow for every kind of work.

Repo projects may organize work directly as tasks or through optional collections, but execution remains session-driven from the project repo root, with tasks holding accountability for execution work and shaping sessions handling proposal-oriented backlog formation.

---

## Phase 1 scope

### What's in

#### 1) Project registry of existing local git repos

- A project is an existing local git repo already present on the machine.
- Projects are the containers that own tasks and optional collections.
- Projects can define customizable task statuses and optional git execution defaults.
- Projects may also define project-local terminology for presentation, such as a `Task label` or `Collection label`, without changing the underlying model.

#### 2) Task model

- Tasks are created manually first.
- Every task belongs to exactly one project.
- Tasks may optionally belong to one collection inside that project.
- Tasks track status, priority, labels, and related sessions.
- No subtasks in v0.
- Project-specific statuses map into global buckets: `todo`, `in_progress`, `done`.
- Collections remain grouping-only in Phase 1; task closure still happens through task status rather than collection state.

Collections are optional grouping containers inside a project. They do not receive sessions directly and do not redefine execution context.

Detailed contracts: `docs/product/task-model.md` and `docs/product/collection-model.md`.

#### 3) Session-first execution

- Sessions are the execution surfaces where agent work happens.
- Phase 1 supports three session paths:
  - task-backed sessions for accountable tracked work
  - project-scoped scratch sessions for quick exploration or Q&A
  - project-scoped shaping sessions for tracked backlog shaping without a task
- Multiple task-backed sessions can exist per task.
- Starting a task-backed ad-hoc session auto-creates a visible task with a generated title.
- Scratch sessions do not create visible tasks and do not participate in backlog tracking.
- Shaping sessions are tracked, resumable, proposal-oriented workspaces that do not create visible tasks directly.
- Accepted shaping proposals become visible backlog items only when the shaping session is finalized.
- All three session kinds use the same execution engine and git controls.
- Sessions remain open until manually closed, except task-backed sessions that auto-close when the task enters a terminal `done`-bucket status.

#### 4) Git execution modes + managed worktrees

- Task-backed sessions start from the task's project repo root.
- Scratch and shaping sessions start from the selected project's repo root.
- Git execution defaults are configurable at two levels:
  - global default
  - nullable project override
- Supported modes:
  - `same_branch`
  - `managed_worktree`
  - `ask_each_time`
- Explicit session choice can override those defaults at session start.
- Managed worktree creation is automated when chosen.
- Merge remains manual.
- Worktree deletion remains manual for now.

Detailed runtime semantics are canonical in `docs/architecture/execution-model.md`.

#### 5) Passive execution tracking + collision warnings

- Isagi records passive execution snapshots on user requests when the observed execution root or branch changes.
- Collision warnings surface when multiple active or idle-but-recent sessions share a directory.
- Git controls remain user-driven; warnings are advisory rather than blocking.

#### 6) Manual task workflow controls

- Status changes are manual in v0.
- There is no standalone `Complete task` action in the MVP; moving a task into a `done`-bucket status is how the product treats it as complete/closed.
- Tasks can carry nullable `priority` and nullable `labels`.
- Statuses are designed to become future automation hooks, but hooks are deferred.

---

### What's out (future phases)

| Feature                                 | Why deferred                                                              |
| --------------------------------------- | ------------------------------------------------------------------------- |
| Mobile app implementation               | Desktop-first focus for MVP velocity                                      |
| In-app full PR/merge orchestration      | Keep merge/release workflows external in MVP                              |
| Active status-change automation hooks   | Keep task upkeep manual and predictable first                             |
| Global spark inbox + spark triage       | Validate the core session/task model before adding backlog feed workflows |
| Roll-up / portfolio projects            | Keep the single-repo execution model sharp before adding aggregation      |
| Project groups / multi-repo execution   | Single-repo projects cover the current real workflow                      |
| Hardcoded YouTube/social deep pipelines | Keep the product generic and repo-centered first                          |
| Multi-user collaboration/permissions    | Solo workflow first                                                       |
| Rich scheduling/reminder system         | Focus on execution continuity before planning features                    |

---

## Technical direction (MVP)

### Platform strategy

- **Desktop is the only active product surface for MVP.**
- Backend remains single-tenant/self-hosted (`SQLite + filesystem + SSE`).
- OpenCode is the session execution engine; Isagi is orchestration/control UX.
- Detailed runtime semantics are canonical in `docs/architecture/execution-model.md`.
- Repo projects may organize work through direct tasks or optional collections, while scratch and shaping sessions still start from the selected project's repo root.

### Core flow

```txt
Project -> Create task or start task-backed ad-hoc session
        -> Session opens in project repo root
        -> Stay on current branch or switch to managed worktree
        -> Continue/resume across one or more sessions
        -> Move task through project-defined statuses until done

Project -> Start scratch session
        -> Session opens in project repo root
        -> Ask questions or do lightweight exploration
        -> Close manually when no longer needed

Project -> Shape what's next
        -> Resume a recent shaping session or start a new one
        -> Session opens in project repo root
        -> Draft task / collection proposals
        -> Accept or reject proposals
        -> Accepted proposals become visible backlog items when the shaping session is finalized
```

---

## Success criteria (initial)

| Metric                | Target                                                              |
| --------------------- | ------------------------------------------------------------------- |
| Task resume rate      | Most active tasks are resumed at least once rather than abandoned   |
| Time-to-first-session | Opening work to first meaningful agent turn is low-friction         |
| Parallel throughput   | Multiple tasks can progress concurrently without context collisions |
| Low-overhead upkeep   | Tasks stay useful without feeling like admin overhead               |
| Collision visibility  | Overlapping directory activity is visible before it causes mistakes |

Qualitative validation signals:

- "I can start work without ceremony."
- "I can keep 2-3 threads going without the tool becoming overhead."
- "I can see when another session is about to stomp this directory."

---

## Risks and mitigations

| Risk                                     | Mitigation                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| Git mode choices create startup friction | Limit to three modes and allow project/global defaults                      |
| Stale sessions make warnings noisy       | Add manual session close and use a recent-activity window                   |
| Managed worktrees create cleanup debt    | Automate creation, keep merge/delete manual, surface cleanup later          |
| Runtime context expectations drift       | Document project repo root as the only guaranteed inherited runtime context |

---

## Near-term implementation priorities

1. Lock project/collection/task/session contracts and status model in API + docs.
2. Implement manual task creation, task-backed ad-hoc session auto-task creation, project-scoped scratch sessions, and project-scoped shaping sessions.
3. Implement session execution surface with git mode selection and rebind behavior.
4. Implement passive snapshots, collision warnings, and session closure states.
5. Implement project registration, explicit git defaults, and read-only execution visibility.
