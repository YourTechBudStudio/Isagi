# Isagi - mental model

**Last updated:** 2026-02-28

This document defines the core concepts and invariants for the active MVP.

## Glossary

### Area

An area defines a stable domain of work and the rules/templates that govern it.

Area responsibilities:

- define defaults and constraints
- define command templates
- define storage mode (`area_monorepo | resource_repos`)
- define default execution root behavior

### Project

A project is a logical grouping of work inside an area.

Projects:

- organize tasks
- can carry project-level default execution root rules
- may be repo-backed depending on area storage mode

### Task

A task is the unit of execution.

Task properties (conceptual):

- belongs to exactly one project
- has session history
- may carry an immutable worktree assignment
- can be started via command templates or as empty chat

### Spark

A spark is a raw idea capture.

Sparks are global inputs that triager develops into proposed project/task structures.

### Resource

A resource is the primary durable output in MVP.

Resources are git-backed units of knowledge/code owned by an area or project and used for context continuity.

### Legacy output model (deprecated)

Earlier drafts used a different durable output concept. MVP uses resources.

Canonical model: `docs/architecture/resources-model.md`.

### Session

A session is a durable execution record tied to a task.

Session categories in practice:

- triage session
- execution chat session
- follow-up session

Multiple sessions can exist under one task.

### Worktree

A worktree is an optional repo/branch-scoped execution environment.

Worktree identity is globally unique by `(repo-key, branch-slug)` and tasks reference it through immutable assignment.

---

## Core invariants

1. **Triager is propose-only.** Nothing is created until user finalizes.
2. **Every task belongs to a project.** No orphan tasks.
3. **Execution root is deterministic.**
4. **Worktree assignment is immutable per task.**
5. **Worktree identity is globally unique by `(repo-key, branch-slug)`.**
6. **Worktree operations are git-context-gated.**
7. **Task close is safety-gated.**
8. **Resources are the MVP durable output layer.**
9. **Only triage/finalize mutates graph objects.** Execution sessions do not directly create spark/project/task objects.

## Resources vs execution

- tasks still anchor sessions and execution history
- sessions run in an execution scope resolved deterministically
- v1 posture is safe-by-review; resources are git-backed and changes are reviewable

---

## Execution root resolver

Execution root resolves in this order:

1. task-level override
2. project default
3. area default
4. area root fallback

`storage_mode` and execution-root defaults are related but independent rules.

---

## Area storage modes

Each area declares one fixed storage mode:

- `area_monorepo`
- `resource_repos`

When `resource_repos` is active, resource creation requires repository initialization via:

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
2. Worktree policy resolves at task creation (task -> project -> area -> system default), and branch baseline is snapshotted.
3. Start empty session or command-driven session; start-time checks handle worktree create/attach when applicable.
4. Task is `started` only after successful environment attach.
5. Session continues across resumptions; multiple sessions under one task reuse the same mapped worktree.
6. Close task runs safety checks unless another active task references the same worktree.
7. On success, task is done, sessions close, and worktree/branch cleanup is conditional on active references + verification checks.
8. Worktree-related start/close failures can move task to `error`; remedy is manual resolution/cleanup then restart from blank task.

Runtime mechanics are canonical in `docs/architecture/execution-model.md`.
Worktree policy and naming constraints are canonical in `docs/product/config/area-project-task-rules.md`.

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

## Resources model (conceptual)

- Resources are git-backed and owned by areas/projects.
- Session scope influences default resource retrieval and context assembly.
- v1 constraints: human/template creation, no attach/detach.

See `docs/architecture/resources-model.md` for operational details.

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
- Exact resources tooling shape (documented as suggested contracts for MVP).
