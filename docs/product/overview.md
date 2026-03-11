# Isagi - product overview (codename)

**Last updated:** 2026-03-11

## One-liner

Isagi is a desktop-first task and session orchestration tool for repo-based work: keep project-scoped tasks and optional collections, run resumable agent sessions, and manage git execution without heavyweight process overhead.

## The problem

- Starting is harder than doing.
- Context loading is expensive and repetitive.
- Parallel coding threads collide without clear visibility into shared execution roots.
- Backlogs decay when there is too much overhead between capture, planning, and execution.

## Value proposition

1. **Start quickly** - create a task, jump into a task-backed ad-hoc session, or open a scratch session when you just need quick repo context.
2. **Warm starts** - sessions resume inside the right project context instead of from zero.
3. **Parallel safely enough** - optional managed worktrees plus collision warnings reduce accidental overlap.
4. **Low-overhead tracking** - tasks hold accountability and progress without becoming a heavyweight workflow system.
5. **Flexible git execution** - stay on the current branch by default or spin up managed worktrees when needed.

## Core principles

- **Desktop-first for MVP.** Keep one primary execution surface.
- **Task-first, not workflow-first.** Use repo projects, optional collections, tasks, and sessions as the minimum stable core.
- **Execution and planning stay separate.** Sessions do the work; tasks track accountability and progress.
- **Low-commitment exploration should stay lightweight.** Scratch sessions are project-scoped and intentionally avoid creating backlog noise when the user only needs quick answers.
- **Grouping should not redefine execution.** Collections may organize work, but repo projects remain the execution containers.
- **User sovereignty over git.** Branch and worktree controls remain user-driven, with warnings instead of hard locks.
- **Backlog tooling can wait.** Spark capture and triage can return in Phase 2 if the task-first core proves worthwhile.
- **Continuity over novelty.** Resume and focus are more important than feed-style discovery.

## Active MVP scenario

Primary scenario: coding/product workflow.

Typical flow:

1. Register an existing local git repo as a project.
2. Organize work directly as tasks or under optional collections, depending on the project's workflow.
3. Create a task or start a task-backed ad-hoc session that auto-creates a task.
4. Run one or more sessions against that task.
5. Stay on the current branch or switch to a managed worktree when needed.
6. Move the task through project-defined statuses until done.
7. Keep backlog planning lightweight; richer spark tooling is deferred until after the first MVP release.

When the user only needs quick project-scoped exploration or Q&A, they may instead start a scratch session. Scratch sessions reuse the same execution shell and git controls, but they do not create tasks or appear on project boards.

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
