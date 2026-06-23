---
title: Full ctx SDK + workflow loading & invocation
status: todo
milestone: agent-workflows
created: 2026-06-21
updated: 2026-06-21
depends_on: [agent-workflows-engine-spine]
---

# Outcome

The runtime can load, start, and fully drive any data-root workflow (via a dev/API trigger),
with the complete `ctx` activity surface available.

# Context

Two halves (splittable along this seam if the task runs large):

- **Complete the `ctx` SDK:** `runHeadlessPrompt` (a new non-interactive `HarnessAdapter`
  launch envelope + stdout capture, modeled as a suspendable `HeadlessResult` op, re-issued
  on restart since it's pure reasoning), `raiseAttention`, `waitForContinue`, `askUser`,
  `callWorkflow` (parent suspends on child return). Human-interaction verbs are tested via
  API stand-ins until the frontend lands.
- **Loading & invocation:** data-root `workflows/<id>/callback.ts` discovery; dynamic TS load
  + hot-reload (re-import per step — this is what makes edit-resilience real); the arg schema
  the callback declares; a runtime API to start a run with bound context (project, worktree,
  surface, originating session).

# Done condition

Done when a suite of tiny demo workflows in the data root, each exercising one verb, runs via
the dev/API trigger: `askUser` round-trips, `waitForContinue` blocks then resumes,
`raiseAttention` surfaces, `runHeadlessPrompt` returns a usable answer, `callWorkflow` returns
a child's value — and editing a callback hot-reloads on the next step.

# Notes

- Trust model: callbacks load in-process with full `ctx` power (user-authored, trusted). Make
  this explicit (carry into the subsystem design doc, `docs/workflow-engine.md`).
- `spawnSession` seed timing: prefer seeding via the launch envelope (initial-prompt arg) over
  a post-launch inject to avoid the harness-not-ready race.
- Carry into this task's brainstorm: arg-schema language (Effect Schema?), error semantics
  (activity throws → reducer catches → error phase), and an optional per-run debug trace for
  diagnosing misbehaving workflows.

# Reference

Deep context in `agent-workflows-design-notes`:

- §7 The `ctx` SDK surface — the read/suspend/spawn/terminate taxonomy, the two species
  (headless transient op vs supervised session), verb-by-verb notes.
- §5 The condition union — the suspend tags the engine resumes on.
- §9 Codebase findings — injection already exists (`pty.write`), headless is net-new (no
  non-interactive `HarnessAdapter` path today).
