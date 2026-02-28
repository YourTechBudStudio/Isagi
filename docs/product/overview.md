# Isagi - product overview (codename)

**Last updated:** 2026-02-28

## One-liner

Isagi is a context continuity engine for execution-heavy knowledge work: capture sparks, triage them into structured work, and run resumable agent sessions so you never restart from zero.

## The problem

- Starting is harder than doing.
- Context loading is expensive and repetitive.
- Parallel tasks collide without clean execution boundaries.
- Ideas and follow-ups decay when not converted into structured work.

## Value proposition

1. **Capture quickly** - sparks are easy to record when ideas hit.
2. **Clarify before committing** - triager strengthens sparks and proposes work in reviewable form.
3. **Warm starts** - every task resumes with context already assembled.
4. **Parallel safely** - task-scoped execution plus repo/branch-scoped shared worktree mapping rules reduce collisions.
5. **Durable thinking** - resources persist with provenance for reuse and filtering.

## Core principles

- **Desktop-first for MVP.** Keep one primary execution surface.
- **Generic primitives over hardcoded workflows.** Build area/project/task first.
- **Propose then commit.** Triager is propose-only; finalize is explicit.
- **Safety over convenience at close time.** Do not allow silent unresolved closures.
- **Continuity over novelty.** Resume and focus are more important than feed-style discovery.

## Active MVP scenario

Primary scenario: coding/product workflow.

Typical flow:

1. Capture spark on desktop.
2. Triager asks clarifying questions and proposes project/task changes.
3. Review and finalize proposals atomically.
4. Open task and run command-driven session(s).
5. Continue until resolved, then close task with safety checks.

Detailed journey: `docs/journeys/coding-workflow.md`.

## Derivative workflows

YouTube/social/content workflows are treated as derivative patterns on top of the same primitives, not hardcoded MVP pipelines.

## Architecture references

- Execution mechanics: `docs/architecture/execution-model.md`
- Resources output model: `docs/architecture/resources-model.md`
- Rules/defaults schema: `docs/product/config/area-project-task-rules.md`

## Non-goals (current MVP)

- Mobile app execution surface.
- Full in-app PR/merge/release orchestration.
- Rich multi-user collaboration and permissions.
- Workflow-specific deep templates as the primary product shape.

## What remains open

- How strict command templates should be per area.
- How far to go on automated task health scoring.
- Which derivative workflows should be added first after core stability.
