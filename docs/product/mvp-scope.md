# MVP Scope (Phase 1)

**Codename:** Isagi  
**Last updated:** 2026-04-28

This document defines what we are building for the MVP.

If anything else in `docs/` conflicts with this scope, this document wins for MVP decisions.

## Overview

Phase 1 is a desktop-first continuation system for one-repo projects.

The MVP objective is to keep project momentum moving by combining Git-backed planning artifacts with backend-owned runtime sessions.

For Phase 1, one project maps to one existing git repo visible to the active backend. Milestones are the primary continuation unit, tasks are reviewable agentic work chunks, sparks are lightweight memory inputs, and sessions are where live agent work happens.

## Phase 1 scope

### 1. Project registry of existing git repos

- A project is registered from an existing git repo visible to the active backend filesystem.
- Multi-repo projects are out of scope for Phase 1.
- Project registration should stay low-ceremony.

### 2. Git-backed planning artifacts

- Durable planning state lives under `.isagi/` in the project repo.
- `.isagi/` belongs in Git by default.
- Planning files are the source of truth.
- The backend may index `.isagi/`, but indexing is optional and rebuildable.
- Recommended artifact areas are milestones, tasks, sparks, and config.

Canonical guidance: `docs/product/planning-artifacts.md`.

### 3. Milestone-centered continuation

- Milestone is the canonical planning and continuation unit.
- Collection is no longer a canonical product concept.
- Discovery helps find or confirm the next milestone.
- Shaping turns a chosen milestone into reviewable agentic tasks.
- Discovery and Shaping propose in chat first and write files only after user confirmation.

### 4. Task-backed execution

- Tasks are reviewable agentic work chunks, not micro-todos.
- Tasks can be linked to milestones but remain execution-agnostic.
- Task-linked sessions attach live execution work to a task.
- No subtasks in v0.
- Task status is manual and project-defined.

### 5. Session-first runtime

- Sessions are live agent conversation surfaces.
- Runtime/session state is backend-owned.
- Sessions may support task execution, scratch exploration, Discovery, or Shaping.
- Sessions are directory-bound; changing execution root creates a new session rather than rebinding the old one.

Detailed runtime semantics: `docs/architecture/execution-model.md`.

### 6. Git execution modes and managed worktrees

- Supported modes remain `same_branch`, `managed_worktree`, and `ask_each_time`.
- Explicit session choice overrides project/default behavior.
- Managed worktree creation may be automated when selected.
- Merge and worktree deletion remain manual in v0.

### 7. Project-defined statuses

- Projects define their own statuses.
- Each status maps into `To-do`, `In progress`, or `Done`.
- Status configuration should be Git-backed where practical, likely under `.isagi/config/`.
- Status automation hooks are out of scope for Phase 1.

### 8. Passive execution tracking and collision warnings

- Isagi records enough runtime state to surface session/execution context.
- Collision warnings remain advisory.
- Git controls remain user-driven rather than hard locks.

## Core flow

```txt
Project repo
  -> .isagi/ planning artifacts
  -> Discovery when the next milestone is unclear
  -> confirmed milestone artifact
  -> Shaping into confirmed task artifacts
  -> task-linked or scratch sessions
  -> git/worktree execution as needed
  -> status changes through project-defined statuses
```

## What's out

- Multi-repo projects.
- Portfolio-level orchestration.
- Heavy spark triage or global spark routing.
- Multi-user permissions for sparks or planning artifacts.
- Over-engineered workflow state machines.
- Exact final schemas for `.isagi/` files.
- Automatic merge or worktree cleanup.
- Full in-app PR/release orchestration.
- Mobile app execution surface.

## Success criteria

- The user can recover what matters next without reconstructing everything from memory.
- The next milestone can be discovered or confirmed without heavyweight planning ceremony.
- Shaping produces tasks that are large enough for agents and small enough for human review.
- Planning state moves with the project through Git.
- Runtime sessions remain resumable and clear enough to avoid context collisions.

## Near-term implementation priorities

1. Lock the `.isagi/` planning artifact conventions at a seed level.
2. Preserve backend ownership of runtime/session state.
3. Implement project registration for existing git repos.
4. Support milestone, task, spark, and config artifacts as Git-backed planning state.
5. Support Discovery and Shaping prompt-template modes with confirmation before file writes.
6. Keep git/worktree execution controls and collision warnings focused and advisory.
