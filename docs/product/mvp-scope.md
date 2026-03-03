# MVP Scope (Phase 1)

**Codename:** Isagi  
**Product name:** Spark System  
**Last updated:** 2026-02-28

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

- Start with spark-strengthening questions before proposing routing or object creation.
- Consult agent-facing area guidance (for example area-level `AGENTS.md`, plus explicitly reading the relevant area-level `TRIAGE.md` as instructed by the triager's automatic starting message; see `docs/product/config/agent-guidance-projections.md`).
- Propose only graph mutations:
  - create spark
  - create project
  - create task
- Keep all proposed changes in review state until user finalizes.
- Graph mutations are committed only through the triage `Finalize` flow.

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
- Non-triage execution sessions do not directly create spark/project/task objects.

#### 6) Command-driven task start

- Start behavior is command/template driven, not task-type hardcoded.
- A task can start with:
  - empty chat session, or
  - command flow (optional setup + optional starter prompt).

#### 7) Worktree lifecycle + close-task safety

- Worktrees are repo-scoped execution environments that live outside `workspace/` under a workspace-sibling worktree root.
- Tasks hold immutable worktree mappings and may reference shared worktrees.
- Worktree policy is resolved at task creation; git/worktree checks and create/attach happen at task start.
- Task creation snapshots source/merge-target branch baseline for later start/close checks.
- If execution root is not inside a git repo, no managed worktree is created.
- Closing a task is blocked until repo state is resolved (merged/discarded), unless another active task references the same worktree.
- When close checks apply, dirty worktree state blocks close.
- Power mode carve-out: in multi-repo execution contexts, some checks may be warn-only when a definitive resolved/unresolved verdict cannot be computed safely; the user must explicitly confirm before closing.
- On successful close:
  - mark task done
  - close associated sessions
  - delete task worktree and branch only when no active references remain and close checks pass
- Worktree-related start/close errors (including missing mapped worktree or branch-baseline drift/removal) are terminal for that task; recovery is manual resolution/cleanup then restart from blank task.

Detailed runtime mechanics are canonical in `docs/architecture/execution-model.md`.

#### 8) Resources model integration

- Resources replace artifact-centric MVP output modeling.
- Resources are git-backed and owned by areas/projects.
- Session/execution scope influences default resource retrieval and context assembly.
- v1 constraint: resources are created by humans or templates; execution sessions do not create resources directly.

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
- Detailed runtime semantics are canonical in `docs/architecture/execution-model.md`.

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
| Resources sprawl without conventions                   | Keep ownership + naming rules and scope-aware retrieval     |

---

## Near-term implementation priorities

1. Lock area/project/task contracts in API + docs.
2. Implement triage review/finalize flow with atomic apply guarantees.
3. Implement task execution surface and multi-session visibility.
4. Implement worktree lifecycle gates for close-task safety.
5. Implement scoped resources tooling + indexing.
