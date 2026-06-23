---
title: Workflow author guide — writer docs (→ authoring skill)
status: todo
milestone: agent-workflows
created: 2026-06-22
updated: 2026-06-22
depends_on: [agent-workflows-sdk-and-invocation, agent-workflows-reference-workflow]
---

# Outcome

A workflow-author guide that lets a developer — or an agent — write a correct, restart-safe
workflow callback from scratch without reading engine internals. Later promoted to an agent
skill so workflows can be authored with agent help.

# Context

Workflows are user-authored `callback.ts` reducers (trusted, in-process). The authoring model
has sharp rules that do **not** show up in the type signature and are easy to get wrong in a way
that corrupts a run:

- everything that crosses a suspension must live in `state` (no local survives a wait);
- `cont` is for phase boundaries only — heavy iteration goes inside a step;
- steps must be re-runnable — the recoverer may re-execute an in-flight step (no exactly-once);
- state must stay edit-safe across live runs (additive/optional fields, `stateVersion`, never
  delete a phase value a live run could be parked in).

The engine-spine brainstorm seeded a running **Writer rules** list (design-notes §12) that this
guide grows into. The guide must cover: the execution model (`suspend`/`cont`, compute-next-
from-event), the full `ctx` SDK surface, the writer rules, and at least one fully worked sample
workflow.

# Done condition

Done when a developer unfamiliar with the engine can read the guide and author a correct,
restart-safe workflow callback without reading engine source — the guide includes the writer
rules, the `ctx` reference, and at least one worked sample (the reference implementation
workflow). Agent-skill packaging either in place or explicitly deferred with a note.

# Notes

- **Sequencing:** do not write this until `ctx` + the workflow syntax are final (the SDK task) —
  documenting a moving target churns. Best authored right after the reference workflow (first
  dogfood): use it as the canonical worked sample and fold in what dogfooding taught about the
  authoring experience.
- Off the critical path; can be written in parallel with the frontend surface.
- The agent-skill packaging is a follow-on once the prose guide is stable.
- Exact home (likely under `docs/`) is for this task's own brainstorm to decide.

# Reference

Deep context in `agent-workflows-design-notes`:

- §12 Writer rules (running list) — the seed for this guide; engine-spine decisions log.
- §3 Execution model — `suspend`/`cont`, compute-next-from-event.
- §7 `ctx` SDK surface — the verbs the guide documents.
- §4 Reference code — the worked `step`-function sample.
