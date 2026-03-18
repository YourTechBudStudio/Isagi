# Isagi - product overview (codename)

**Last updated:** 2026-03-17

## One-liner

Isagi is a desktop-first task and session orchestration tool for repo-based work: keep project-scoped tasks and optional collections, run resumable agent sessions, and manage git execution without heavyweight process overhead.

## The problem

- Starting is harder than doing.
- Context loading is expensive and repetitive.
- Parallel coding threads collide without clear visibility into shared execution roots.
- Backlogs decay when there is too much overhead between capture, planning, and execution.

## Value proposition

1. **Start quickly** - create a task, jump into a task-backed ad-hoc session, open a scratch session for quick repo context, or open a shaping session when the backlog itself still needs form.
2. **Warm starts** - sessions resume inside the right project context instead of from zero.
3. **Parallel safely enough** - optional managed worktrees plus collision warnings reduce accidental overlap.
4. **Low-overhead tracking** - tasks hold accountability and progress without becoming a heavyweight workflow system.
5. **Flexible git execution** - stay on the current branch by default or spin up managed worktrees when needed.

## Core principles

- **Desktop-first for MVP.** Keep one primary execution surface.
- **Task-centered for execution, not workflow-first.** Use repo projects, optional collections, tasks, and sessions as the minimum stable core, while letting shaping remain a separate project-scoped lane.
- **Execution and shaping stay separate.** Task-backed sessions do accountable work; shaping sessions turn ambiguity into backlog; scratch stays lightweight.
- **Low-commitment exploration should stay lightweight.** Scratch sessions are project-scoped and intentionally avoid creating backlog noise when the user only needs quick answers.
- **Grouping should not redefine execution.** Collections may organize work, but repo projects remain the execution containers.
- **User sovereignty over git.** Branch and worktree controls remain user-driven, with warnings instead of hard locks.
- **Backlog tooling can wait.** Spark capture and triage can return in Phase 2 if the core project/task/session model proves worthwhile.
- **Continuity over novelty.** Resume and focus are more important than feed-style discovery.

## Active MVP scenario

Primary scenario: coding/product workflow.

Typical flow:

1. Register an existing local git repo as a project.
2. Organize work directly as tasks or under optional collections, depending on the project's workflow.
3. When backlog shape is still fuzzy, start a project-scoped shaping session to draft proposed tasks or collections.
4. Create a task or start a task-backed ad-hoc session that auto-creates a task.
5. Run one or more sessions against that task.
6. Stay on the current branch or switch to a managed worktree when needed.
7. Move the task through project-defined statuses until done.
8. Keep backlog planning lightweight; richer spark tooling is deferred until after the first MVP release.

When the user only needs quick project-scoped exploration or Q&A, they may instead start a scratch session. Scratch sessions reuse the same execution shell and git controls, but they do not create tasks or appear on project boards.

When the user needs to shape the backlog itself, they may instead start a shaping session. Shaping sessions are tracked and resumable like other sessions, but they remain project-scoped and stage proposed backlog items until the shaping session is finalized.

Detailed journey: `docs/journeys/coding-workflow.md`.

## Derivative workflows

Outcome-centric workflows such as content or video work are expected to fit inside the same repo-project model by using optional collections plus project-defined task statuses, without changing execution-root semantics.

## Architecture references

- Collection model: `docs/product/collection-model.md`
- Task model: `docs/product/task-model.md`
- Execution mechanics: `docs/architecture/execution-model.md`
- Project/task git rules: `docs/product/config/project-task-git-rules.md`
- Agent guidance projections: `docs/product/config/agent-guidance-projections.md`

## Non-goals (current MVP)

- Mobile app execution surface.
- Fully automated merge and cleanup workflows.
- Strict workflow enforcement for all work.
- Global spark inbox + spark triage in the first MVP release.
- Project-group / multi-repo execution as an active MVP feature.
- Full in-app PR/merge/release orchestration.
- Rich multi-user collaboration and permissions.

## What remains open

- What the Phase 2 spark inbox + spark-triage backlog feeder should look like.
- When git-safety behavior should become stricter than warnings/manual cleanup.
- How much passive context assembly should happen automatically on session resume.
- Which team-oriented features matter first after solo workflow stability.
