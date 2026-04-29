# Value Proposition Canvas

**Codename:** Isagi  
**Last updated:** 2026-04-28

This canvas is the strategic framing source of truth. For MVP build decisions, `docs/product/mvp-scope.md` wins.

## Customer jobs

- Continue project work without repeatedly reconstructing context.
- Know the next meaningful milestone when the current direction is done, stale, or unclear.
- Shape a milestone into reviewable agentic tasks without heavyweight PM ceremony.
- Resume task execution quickly once the work is concrete.
- Capture lightweight sparks so useful ideas can inform later discovery.
- Keep planning state close to the project and reviewable through Git.

## Pains

- **Milestone-boundary cold starts** - the work stalls because the next meaningful direction is unclear.
- **Execution cold starts** - the task exists, but the context needed to continue has gone cold.
- **Backlog decay** - tasks lose the reasoning that made them worth doing.
- **Planning ceremony** - administrative workflow creates friction instead of momentum.
- **Scattered context** - ideas, docs, decisions, and sessions live in too many places.
- **Over-small tasks** - pre-agent task granularity creates too much planning overhead.

## Gains

- **Momentum recovery** - the system helps reconstruct what matters next.
- **Warm starts** - sessions resume with relevant context instead of from zero.
- **Milestone confidence** - the user can see why the current milestone matters.
- **Agent-era task shape** - tasks are large enough for agents and reviewable by humans.
- **Git-backed memory** - planning context moves with the project.
- **Co-ownership** - agents help frame and execute while the user keeps final judgment.

## Value map

- **Milestone-centered continuation** helps recover direction at planning boundaries.
- **Discovery prompt mode** proposes the next milestone from project context, sparks, tasks, and files.
- **Shaping prompt mode** turns a milestone into reviewable tasks.
- **Git-backed `.isagi/` artifacts** keep planning memory durable and portable.
- **Backend-owned sessions** keep runtime state, harness bindings, and execution roots manageable.
- **Project-defined statuses** preserve workflow flexibility without a heavyweight state machine.

## Core value proposition statement

> Isagi minimizes project cold starts so the user can keep momentum going.
>
> When execution is clear, it helps resume work quickly. When direction is unclear, it helps discover the next milestone and shape it into agent-era tasks. Durable planning state stays with the project; runtime state stays in the backend.

## Design principles

1. **Momentum over management** - planning should enable action.
2. **Milestones over task soup** - the current continuation unit is the milestone.
3. **Files over hidden planning databases** - durable planning state belongs in Git-backed project files.
4. **Prompts over rigid agents** - Discovery and Shaping are command-template modes, not separate agent classes.
5. **Co-ownership over delegation** - the user confirms direction before files are written.
6. **Agent-era task size** - tasks should be meaningful chunks of work, not micro-todos.
