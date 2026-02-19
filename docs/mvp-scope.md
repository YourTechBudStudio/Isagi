# MVP Scope (Phase 1)

**Codename:** Isagi  
**Product name:** Spark System  
**Last updated:** 2026-02-19

This document defines what we are building for the MVP.

If anything else in `docs/` conflicts with this scope, **this document wins for MVP decisions**.

---

## Overview

Phase 1 is a **desktop-first coding/product workflow continuity system**.

The MVP objective is to reduce activation energy by making every task feel resumable, contextual, and safe to execute with parallel agent sessions.

The system remains generic: no hardcoded YouTube/social pipelines in MVP.

---

## Phase 1 scope

### What's in

#### 1) Desktop spark capture

- Create sparks directly in desktop.
- Capture is lightweight and low-friction (short text-first input).
- New spark creation may immediately offer `Open triage now`.

#### 2) Smart triager (propose-only)

Triager runs automatically on spark creation, but remains **propose-only**.

Triager behavior in MVP:

- Strengthen unclear sparks via clarifying questions.
- Read area/project/task rules from filesystem configuration.
- Propose only graph mutations:
  - create spark
  - create project
  - create task
- Keep all proposed changes in review state until user finalizes.

#### 3) Proposal review and atomic finalize

- Triager proposals are file-backed and reviewable.
- User can approve/reject/edit individually or in bulk.
- `Finalize` applies all approved proposals atomically.
- Unapproved proposed items are auto-rejected on finalize.

#### 4) Area/Project/Task model (generic primitives)

- `Area` = rules/templates/defaults.
- `Project` = logical grouping under an area.
- `Task` = executable unit.
- Every task must belong to a project.

#### 5) Task execution and multi-session workflow

- Opening a task opens a chat/session surface.
- Multiple sessions can exist per task.
- Focus queue is task-first with session-level visibility.
- Sessions can be resumed from home/dashboard and task views.

#### 6) Command-driven task start

- Start behavior is command/template driven, not task-type hardcoded.
- A task can start with:
  - empty chat session, or
  - command flow (optional setup + optional starter prompt).

#### 7) Worktree lifecycle + close-task safety

- Worktree lifecycle is tied to task lifecycle.
- Tasks can reuse the same attached worktree across multiple sessions.
- Closing a task is blocked until repo state is resolved (merged/discarded).
- On successful close:
  - mark task done
  - close associated sessions
  - delete task worktree and branch

#### 8) Notes model integration

- Notes replace artifact-centric MVP output modeling.
- Notes are global storage with area/project/task provenance.
- Session scope determines default note search scope.

---

### What's out (future phases)

| Feature                                 | Why deferred                                           |
| --------------------------------------- | ------------------------------------------------------ |
| Mobile app implementation               | Desktop-first focus for MVP velocity                   |
| In-app full PR/merge orchestration      | Keep merge/release workflows external in MVP           |
| Hardcoded YouTube/social deep pipelines | Build generic primitives first                         |
| Multi-user collaboration/permissions    | Solo workflow first                                    |
| Rich scheduling/reminder system         | Focus on execution continuity before planning features |

---

## Technical direction (MVP)

### Platform strategy

- **Desktop is the only active product surface for MVP.**
- Backend remains single-tenant/self-hosted (`SQLite + filesystem + SSE`).
- OpenCode is the session execution engine; Isagi is orchestration/control UX.

### Core flow

```
Spark -> Triager (propose-only) -> Review -> Finalize (atomic)
     -> Task open -> Session(s) + optional worktree
     -> Continue/resume until resolved
     -> Close task (safety checks) -> Done + cleanup
```

---

## Success criteria (initial)

| Metric                  | Target                                                              |
| ----------------------- | ------------------------------------------------------------------- |
| Task resume rate        | Most active tasks are resumed at least once rather than abandoned   |
| Triager finalize rate   | Proposed changes are regularly finalized, not left stale            |
| Time-to-first-execution | Opening a task to first meaningful agent turn is low-friction       |
| Parallel throughput     | Multiple tasks can progress concurrently without context collisions |
| Close-task safety       | No accidental task closure with unresolved repo state               |

Qualitative validation signals:

- "I can pick up where I left off instantly."
- "I can run multiple coding threads without stepping on myself."
- "I trust task close behavior to prevent accidental loss."

---

## Risks and mitigations

| Risk                                                   | Mitigation                                                  |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| Scope drift into workflow-specific templates too early | Keep model generic; encode behavior via rules/config        |
| Git lifecycle edge cases create user confusion         | Keep close-task gates explicit and error states inspectable |
| Proposal queue grows without decisions                 | Keep review/finalize UX fast and batch-friendly             |
| Notes become unstructured quickly                      | Keep provenance tags + scoped search from day one           |

---

## Near-term implementation priorities

1. Lock area/project/task contracts in API + docs.
2. Implement triage review/finalize flow with atomic apply guarantees.
3. Implement task execution surface and multi-session visibility.
4. Implement worktree lifecycle gates for close-task safety.
5. Implement scoped notes tools + indexing.
