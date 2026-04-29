# Isagi - mental model

**Last updated:** 2026-04-28

This document defines the active product concepts for the MVP.

## Core model

### Project

A project is the main context where continuation happens.

In the MVP, a project maps to one existing git repo visible to the active backend. The product should not permanently assume that every future project is exactly one repo, but multi-repo projects are out of scope for now.

### Milestone

A milestone is the primary continuation and planning object.

Milestones replace Collections as the canonical grouping concept. A milestone is first-class: it carries the direction, context, and completion posture needed to continue meaningful work later.

Milestone details and qualities live in `docs/product/planning-artifacts.md`.

### Task

A task is a reviewable agentic work chunk that is concrete enough to execute without another discovery session.

Tasks usually advance a milestone after Shaping, but may also live directly under a project for ad hoc or small work.

Tasks are execution-agnostic. Branches, worktrees, and sessions are execution choices, not task identity.

### Spark

A spark is something worth remembering that may or may not influence future discovery.

Sparks are lightweight memory inputs. They are not proto-tasks and do not require individual triage ceremonies.

### Session

A session is a live agent conversation and execution surface.

Sessions may support execution, scratch exploration, Discovery, or Shaping, but they share the same basic posture: the conversation is where agent work happens.

## Planning artifacts

Durable planning state lives as Git-backed Markdown artifacts under `.isagi/`.

This includes milestone, task, spark, and project config artifacts. Files are the source of truth. Backend indexing is optional and rebuildable.

Canonical artifact guidance lives in `docs/product/planning-artifacts.md`.

## Runtime state

The backend owns runtime/session state:

- session records
- harness session bindings
- execution roots
- worktree bindings
- collision state
- transient runtime metadata

Runtime state is not rebuilt from `.isagi/` planning files.

## Discovery and shaping

Discovery and Shaping are prompt-template modes over the same core brainstorming capability.

- **Discovery** finds or confirms the next milestone.
- **Shaping** turns a milestone into reviewable agentic tasks.

Both modes should propose direction in chat first and write planning artifacts only after user confirmation.

UI may adapt side panels for these modes, but the model does not require separate agent types.

## Status model

Projects define their own statuses.

Each status maps into one of three global groups:

- `To-do`
- `In progress`
- `Done`

Status configuration should be project-owned and Git-backed where practical, likely under `.isagi/config/`.

## Core invariants

1. In the MVP, every project maps to one existing git repo visible to the active backend.
2. Milestones are the current continuation center.
3. Durable planning state lives in `.isagi/` files.
4. Runtime/session state is backend-owned.
5. Tasks are execution-agnostic.
6. Sessions are live agent conversations bound to runtime execution state.
7. Discovery and Shaping are prompt-template modes, not separate agent classes.
8. Project-defined statuses map to `To-do`, `In progress`, or `Done`.
9. No subtasks in v0.

## References

- Product overview: `docs/product/overview.md`
- Planning artifacts: `docs/product/planning-artifacts.md`
- MVP scope: `docs/product/mvp-scope.md`
- Execution mechanics: `docs/architecture/execution-model.md`
- System architecture: `docs/architecture/system-architecture.md`
