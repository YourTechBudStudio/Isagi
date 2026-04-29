# Isagi - product overview (codename)

**Last updated:** 2026-04-28

## One-liner

Isagi is a continuation system for project momentum. In the MVP, a project maps to an existing git repo; durable planning state lives as Git-backed artifacts under `.isagi/`, while runtime/session state lives in the backend.

## The problem

- Execution stalls when the next task is known but context has gone cold.
- Planning stalls when the current milestone is done, stale, or unclear.
- Backlogs decay when they do not preserve enough reasoning to restart momentum.
- Heavy PM ceremony creates more friction than it removes.

## Value proposition

1. **Milestone-centered continuation** - help the user recover the next meaningful direction when momentum breaks.
2. **Warm execution starts** - keep tasks and sessions close enough that work resumes without reloading all context manually.
3. **Git-backed planning memory** - keep milestones, tasks, sparks, and project config in project files that move with the repo.
4. **Lightweight discovery and shaping** - use prompt-template modes to discover the next milestone and shape it into agent-era tasks.
5. **Backend-owned runtime** - keep sessions, harness bindings, execution roots, and collision state in the backend.

## Core principles

- **Action first.** Planning exists to restore confidence and enable execution, not to become a workflow ceremony.
- **Milestones are the current continuation center.** Future versions may let projects choose another center of gravity, but the MVP is milestone-centered.
- **Files own durable planning state.** The backend may index `.isagi/`, but files remain the source of truth.
- **Sessions own live work.** Runtime state belongs to the backend and harness layer.
- **Sparks stay lightweight.** A spark is memory context, not a proto-task or mandatory triage item.
- **Tasks fit the agent era.** A task should be a reviewable chunk of agentic work, not a micro-todo.
- **Repo is the MVP container, not the permanent philosophy.** For the MVP, one project maps to one existing git repo.

## Active MVP scenario

Primary scenario: coding/product workflow in one existing git repo.

Typical flow:

1. Register an existing git repo path visible to the active backend as a project.
2. Capture or maintain planning artifacts under `.isagi/`.
3. Use Discovery when the next milestone is unclear.
4. Confirm a milestone before writing or updating milestone files.
5. Use Shaping to turn that milestone into a few reviewable agentic tasks.
6. Confirm task artifacts before writing them.
7. Run task-linked sessions, scratch sessions, or Discovery or Shaping sessions as needed.
8. Use project-defined statuses grouped into `To-do`, `In progress`, and `Done`.
9. Use git/worktree execution controls when isolation is useful.

Detailed journey: `docs/journeys/coding-workflow.md`.

## References

- Mental model: `docs/product/mental-model.md`
- Planning artifacts: `docs/product/planning-artifacts.md`
- MVP scope: `docs/product/mvp-scope.md`
- Execution mechanics: `docs/architecture/execution-model.md`
- System architecture: `docs/architecture/system-architecture.md`

## Non-goals (current MVP)

- Multi-repo project orchestration.
- Heavy workflow state machines.
- Full global spark routing or multi-user spark permissions.
- Strict schema design for every planning artifact field.
- Replacing normal Git review for planning artifact changes.
- Full in-app PR/merge/release orchestration.
- Mobile app execution surface.

## What remains open

- Exact `.isagi/` file schemas and config files.
- How much optional indexing the backend needs.
- Which side-panel affordances Discovery and Shaping should get.
- When projects should support continuation centers beyond milestones.
