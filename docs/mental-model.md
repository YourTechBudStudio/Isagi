# Isagi - mental model

**Last updated:** 2026-02-19

This document defines the core concepts and invariants for the active MVP.

## Glossary

### Area

An area defines a stable domain of work and the rules/templates that govern it.

Area responsibilities:

- define defaults and constraints
- define command templates
- define git mode (`none | area_repo | project_repo`)
- define default execution root behavior

### Project

A project is a logical grouping of work inside an area.

Projects:

- organize tasks
- can carry project-level default execution root rules
- may map to a git repo depending on area git mode

### Task

A task is the unit of execution.

Task properties (conceptual):

- belongs to exactly one project
- has session history
- may have an attached worktree lifecycle
- can be started via command templates or as empty chat

### Spark

A spark is a raw idea capture.

Sparks are global inputs that triager develops into proposed project/task structures.

### Note

A note is the primary durable output in MVP.

Notes are global storage objects with provenance tags (spark/area/project/task references) used for scoping and future filtering.

### Session

A session is a durable execution record tied to a task.

Session categories in practice:

- triage session
- execution chat session
- follow-up session

Multiple sessions can exist under one task.

### Worktree

A worktree is an optional execution environment attached to a task.

Worktree lifecycle is task-scoped, not session-scoped.

---

## Core invariants

1. **Triager is propose-only.** Nothing is created until user finalizes.
2. **Every task belongs to a project.** No orphan tasks.
3. **Execution root is deterministic.**
4. **Worktree lifecycle is task-bound.**
5. **Task close is safety-gated.**
6. **Notes are the MVP output layer.**
7. **Only triage/finalize mutates graph objects.** Execution sessions do not directly create spark/project/task objects.

---

## Execution root resolver

Execution root resolves in this order:

1. task-level override
2. project default
3. area default
4. area root fallback

`git_mode` and execution-root defaults are related but independent rules.

---

## Area git modes

Each area declares one fixed git mode:

- `none`
- `area_repo`
- `project_repo`

When `project_repo` is active, project creation requires repo initialization via:

- clone from URL, or
- create empty local git repo (remote optional later)

---

## Triage model

Triage flow:

1. Spark is created.
2. Triager clarifies/strengthens the spark first (questions before routing/proposals when needed).
3. Triager proposes graph changes (spark/project/task only).
4. User reviews proposals in a review surface.
5. Finalize applies approved proposals atomically.

Triage output states include proposed/approved/rejected/applied semantics in implementation, but user-facing behavior is review then finalize.

---

## Task/session/worktree lifecycle

1. Open task.
2. Start empty session or command-driven session.
3. Optional setup runs (for commands that require environment prep).
4. Session continues across resumptions.
5. Multiple sessions can run under same task.
6. If task has worktree, sessions reuse that worktree.
7. Close task requires resolved repo state.
8. On success, task is done, sessions close, worktree/branch clean up.

Runtime failure, verification, and sync details are canonical in `docs/architecture/execution-model.md`.

---

## Home and focus model (desktop-first)

Home/dashboard prioritizes:

1. resume
2. focus queue
3. spark triage

Focus queue is task-first, with session-level visibility:

- waiting-on-you sessions prioritized
- active/idle sessions visible as chips/badges

---

## Notes model (conceptual)

- Notes are globally stored, not coupled to code repo commits.
- Session scope determines default note search scope.
- Read-before-write semantics are enforced for safe concurrent edits.
- Canonical taxonomy supports area/project-oriented organization.

See `docs/architecture/notes-model.md` for operational details.

---

## Example (coding spark to execution)

Spark: "Use git worktrees to parallelize small coding tasks."

1. Spark captured on desktop.
2. Triager asks clarifying questions and proposes:
   - one project/task for product implementation
   - optional follow-on proposals if approved
3. User reviews and finalizes proposals.
4. User opens task and starts command-driven coding session.
5. Work continues across one or more sessions on the same task.
6. Task closes only after repo state passes safety checks.

---

## What remains intentionally flexible

- Exact command template schema details.
- Exact UI polish for review/focus surfaces.
- Exact notes tool shape (documented as suggested contracts for MVP).
