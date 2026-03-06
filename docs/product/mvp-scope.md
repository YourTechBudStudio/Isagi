# MVP Scope (Phase 1)

**Codename:** Isagi  
**Product name:** Spark System  
**Last updated:** 2026-03-06

This document defines what we are building for the MVP.

If anything else in `docs/` conflicts with this scope, **this document wins for MVP decisions**.

---

## Overview

Phase 1 is a **desktop-first task and session orchestration system for repo-based coding/product work**.

The MVP objective is to reduce activation energy and increase throughput by making project-scoped work easy to start, resume, and run in parallel with agent sessions.

The product remains ad-hoc: Isagi supports specialized workflows, but does not force one rigid workflow for every kind of work.

---

## Phase 1 scope

### What's in

#### 1) Project registry of existing local git repos

- A project is an existing local git repo already present on the machine.
- Projects are the containers that own tasks.
- Projects can define customizable task statuses and optional git execution defaults.

#### 2) Task model

- Tasks are created manually first.
- Every task belongs to exactly one project.
- Tasks track status, priority, labels, and related sessions.
- No subtasks in v0.
- Project-specific statuses map into global buckets: `todo`, `in_progress`, `done`.

Detailed contract: `docs/product/task-model.md`.

#### 3) Session-first execution

- Sessions are the execution surfaces attached to tasks.
- Multiple sessions can exist per task.
- Starting an ad-hoc session auto-creates a visible task with a generated title.
- Sessions remain open until manually closed or the task enters a terminal `done`-bucket status.

#### 4) Git execution modes + managed worktrees

- Sessions start from the task's project repo root.
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
- Tasks can carry nullable `priority` and nullable `labels`.
- Statuses are designed to become future automation hooks, but hooks are deferred.

---

### What's out (future phases)

| Feature                                 | Why deferred                                                      |
| --------------------------------------- | ----------------------------------------------------------------- |
| Mobile app implementation               | Desktop-first focus for MVP velocity                              |
| In-app full PR/merge orchestration      | Keep merge/release workflows external in MVP                      |
| Active status-change automation hooks   | Keep task upkeep manual and predictable first                     |
| Global spark inbox + spark triage       | Validate the task-first core before adding backlog feed workflows |
| Project groups / multi-repo execution   | Single-repo projects cover the current real workflow              |
| Hardcoded YouTube/social deep pipelines | Keep the product generic and repo-centered first                  |
| Multi-user collaboration/permissions    | Solo workflow first                                               |
| Rich scheduling/reminder system         | Focus on execution continuity before planning features            |

---

## Technical direction (MVP)

### Platform strategy

- **Desktop is the only active product surface for MVP.**
- Backend remains single-tenant/self-hosted (`SQLite + filesystem + SSE`).
- OpenCode is the session execution engine; Isagi is orchestration/control UX.
- Detailed runtime semantics are canonical in `docs/architecture/execution-model.md`.

### Core flow

```txt
Project -> Create task or start ad-hoc session
        -> Session opens in project repo root
        -> Stay on current branch or switch to managed worktree
        -> Continue/resume across one or more sessions
        -> Move task through project-defined statuses until done
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

1. Lock project/task/session contracts and status model in API + docs.
2. Implement manual task creation and ad-hoc session auto-task creation.
3. Implement session execution surface with git mode selection and rebind behavior.
4. Implement passive snapshots, collision warnings, and session closure states.
5. Implement project registration, explicit git defaults, and read-only execution visibility.
