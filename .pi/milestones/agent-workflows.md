---
title: Agent Workflows
status: ready
created: 2026-06-21
updated: 2026-06-21
tags: [workflows, orchestration, runtime, agents, effect]
---

# Summary

A durable, user-authored workflow engine in the runtime that automates the repeatable
multi-agent loops the user currently drives by hand. Workflows are reducers written as
`callback.ts` files in the data root; the runtime executes them as durable state machines
that drive real agent sessions — spawning panes, injecting prompts, reading turns, calling
sub-workflows — and escalate to the human only at genuine decision points.

The substrate is built once and proven on one real workflow (the phase-implementation
reconciliation loop). Other workflows the user already runs by hand (research, YouTube)
follow on the same engine later.

# Why this matters

The user runs a repeatable meta-workflow with agents: milestone → tasks → per-task
brainstorm → a phase loop where an implementation agent pushes back on a plan and a
"planner" agent (holding the rationale) adjudicates, mostly via templated copy-paste, then a
review loop. The judgment is already delegated — the planner agent is a watchdog instructed
to escalate only on a real flag — so what remains is hours of mechanical message-routing.

Automating the routing while keeping the escalation gate reclaims those hours and pushes
toward higher autonomy ("run it while I sleep") as agents and review systems mature. Primary
customer is the user (built for me first).

# Direction

Architecture decided during shaping:

- **Durable state machine, not Temporal-style replay.** Workflows are reducers over an
  explicit, serializable state object. The engine persists state at every suspension
  (snapshot-at-suspension), so recovery loads the last snapshot rather than replaying
  history from t=0 — chosen for edit-resilience (the user hand-edits workflows while runs
  are in flight) and natural non-linear phase flow.
- **Two control verbs.** Between suspensions the reducer runs synchronously and `await`s
  fast activities inline; to wait on a long external event it returns `suspend(nextState,
  condition)`; `cont(nextState)` persists and steps again immediately. Each `await_*` phase
  is a named, serializable continuation.
- **`ctx` is the activity surface.** Every call on `ctx` is an activity (no formal Activity
  type yet — extensible later for external systems). Reads don't suspend; long operations
  (agent turn, user input, sub-workflow, headless prompt) are suspensions resumed by events.
- **Runtime-owned; UI is a projection.** Workflows run in the runtime and survive runtime
  restarts. State is opaque to the runtime (`state_json` — never introspected); everything
  observable goes through `ctx` (operating phase, attention).
- **Turn detection rides existing infra.** New `turn_start`/`turn_end` lifecycle events
  (distinct from the attention `agent_session_changed` signal) plus conversation capture in
  the JSONL ledger; resume via the existing internal event bus and a watermark (injection
  timestamp T → first `turn_start ≥ T` then its `turn_end`).
- **Ownership via surface lockdown.** A running workflow is scoped to a surface; the surface
  locks input while running and unlocks when waiting/done — arbitrating human/workflow
  collision without a complex ownership model.
- Build on Effect; no external workflow library; in-process.

Path is foundation-first with an early vertical proof: instrument turn boundaries +
conversation; stand up a walking-skeleton engine that survives a mid-run restart; complete
the SDK + loading; dogfood the real implementation loop before polishing the UI. See
`agent-workflows-task-order`.

# Done condition

Done when the user can author a workflow as a data-root `callback.ts`, invoke it, and have it
drive real agent sessions through a multi-phase loop end-to-end — surviving a runtime
restart — with the implementation reconciliation workflow (`agent-workflows-reference-workflow`)
running as the first real dogfood. Each task carries its own observable proof; the
milestone's proof is running the reference workflow on a real task and reclaiming the manual
copy-paste loop.

# Boundaries

## In direction

- Durable workflow engine (state machine, snapshot persistence, suspend/resume) in the runtime.
- The `ctx` SDK: spawn, inject, getConversationHistory, setOperatingPhase, raiseAttention,
  waitForContinue, askUser, runHeadlessPrompt, callWorkflow.
- Harness instrumentation: `turn_start`/`turn_end` + conversation capture (text-only) across
  Pi, Claude, Codex, OpenCode.
- Data-root workflow loading + hot-reload + arg schema + palette invocation.
- Frontend: operating phase / rail, surface lockdown, pause/cancel/continue, dynamic panes.
- The reference implementation workflow as dogfood.
- Agent-facing "run a workflow" tool (last; may split to a follow-up milestone).

## Out of direction

- A formal Activity abstraction for external (non-runtime) systems — `ctx`-only for now,
  designed to extend later.
- Durability of fast intra-segment effects — re-run the segment on crash; accept rare double
  inject/spawn (idempotency keys are a future lever).
- Recording tool calls / tool results in conversation capture — assistant/user text only.
- The full set of user workflows (research, YouTube) — substrate proven on the
  implementation loop; others follow on the same engine.
- Deciding the agent-facing tool's blocking/return mechanism up front — deferred to dogfooding.

# Continue with

Start at `agent-workflows-harness-instrumentation` (Pi first), then `agent-workflows-engine-spine`.
The hard gate is the engine spine surviving a mid-run `kill -9`; do not invest in tasks 3–5
until it does. Build order in `agent-workflows-task-order`.

# Notes

- **Full design reference** — reference code, the durability deep-dive, the `ctx` taxonomy,
  codebase findings with file refs, the decisions log, and open questions — lives in
  `agent-workflows-design-notes`. Read it before any task brainstorm.
- New subsystem ADR to land with the engine spine (durable state machine on Effect vs
  Temporal replay, opaque-state boundary, ctx-as-activity, suspend/resume). ADR 0007 to be
  updated with the expanded hook usage in the instrumentation task.
- Failure spots surfaced during shaping: harness turn signalling is heterogeneous (edge
  `Stop` vs level `pending`/`status`); "waiting" conflates turn-done with blocked-on-prompt;
  records carry only a string `recordedAt`, no sequence id (→ injection-timestamp watermark);
  the live attention dot is process-liveness-gated (resume off raw JSONL records, not the
  dot); instrumentation is best-effort (ADR 0007), so degraded/timeout paths must escalate
  rather than hang.
- Shaped 2026-06-21 via an extended brainstorm.
