---
title: Reference implementation workflow (first dogfood)
status: todo
milestone: agent-workflows
created: 2026-06-21
updated: 2026-06-21
depends_on: [agent-workflows-sdk-and-invocation]
---

# Outcome

The user's real phase-implementation loop, authored as an example `callback.ts` and run on an
actual task — the first real workflow tried, and the integration proof for the whole engine.

# Context

This is the workflow the milestone was shaped around. For each phase: spawn an implementation
agent, run the reconcile loop (impl agent asks / pushes back → route to the planner agent via
the user's template → planner replies "no flags" or escalates a flag → loop until aligned →
implement), commit per phase, optionally stop for review (the `reviewMode` knob = a
`waitForContinue` between phases), and surface a planted flag to the human then continue. It
runs against a pre-existing planner/brainstorm session as origin and spawns the impl agents.

Built deliberately before the frontend so the real value is dogfooded early with minimal UI
(watch the panes directly). Day one can lean on output markers (`NO FLAGS` / `ALIGNED`) plus
reading the plan markdown file, so it need not depend on `runHeadlessPrompt`.

# Done condition

Done when the user runs this workflow on a real task start-to-finish: the reconcile loop
converges on "no flags," per-phase commits land, `reviewMode` stops for review when set, and a
planted flag escalates and waits for `continue`. The proof is using it for real and reclaiming
the manual copy-paste loop.

# Notes

- Labeled an example/testing workflow — it is both a deliverable and the integration test for
  tasks 1–3.
- Whatever it surfaces (missing SDK affordances, UX friction) feeds back into the SDK and
  frontend tasks.

# Reference

Deep context in `agent-workflows-design-notes`:

- §4 Reference code — the `step`-function sketch of *this exact workflow* (state shape, the
  reconcile loop, the `reviewMode` knob, the flag→escalate→continue path).
- §1 The problem — the copy-paste loop this automates, why the two-agent split exists, and the
  distributed-cognition-with-a-watchdog framing.
