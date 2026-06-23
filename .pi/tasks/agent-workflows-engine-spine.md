---
title: Workflow engine spine — durable state machine (restart-survival gate)
status: todo
milestone: agent-workflows
created: 2026-06-21
updated: 2026-06-21
depends_on: [agent-workflows-harness-instrumentation]
---

# Outcome

A workflow engine that runs a hardcoded reducer end-to-end against a real agent session, built
**durable-by-design** (DB-as-truth, snapshot-at-suspension) so a run survives a runtime restart
by construction. The architecture de-risk for the whole milestone — explicit `kill -9`
verification is deferred to dogfooding (see Done condition).

# Context

Workflows are reducers over an explicit serializable state object. The engine:

- persists state at every suspension (snapshot-at-suspension) in a new `workflow_runs` table
  — opaque `state_json` + `pending` + status + operating-phase columns (the runtime never
  introspects `state_json`);
- exposes `suspend(nextState, condition)` (persist + wait for an event) and `cont(nextState)`
  (persist + step again now);
- wires the suspend/resume registry to the existing `InternalRuntimeEventBus`, resuming on
  `turn_end` and reconciling pending waits against the JSONL ledger on restart (the live
  attention dot is process-liveness-gated and lossy, so resume off the raw records);
- includes just enough SDK (`spawnSession`, `inject`, `getConversationHistory`,
  `setUiFeedback`) and a dev trigger to run one hardcoded callback.

Resume watermark: the engine stamps injection time T and resumes on the first `turn_start ≥ T`
then its `turn_end`. Build on Effect, in-process. Land the new subsystem **design doc**
(`docs/workflow-engine.md`, a living explainer — not an ADR) here: durable state machine vs
Temporal replay, opaque-state boundary, ctx-as-activity, suspend/resume — with a
key-decisions-&-rationale section that preserves the "why not Temporal" reasoning.

# Done condition

Done when the trivial test workflow runs end to end via the dev trigger — spawn a Pi session,
inject a prompt, wait for `turn_end`, read the reply via `getConversationHistory`, set UI
feedback to done — AND the `workflow_runs` row + logs confirm the durable machinery actually
ran: state snapshotted at each suspension, the row moving `waiting → ready → running → done`,
the resolver flipping on `turn_end`. The full durable design is built (DB-as-truth,
snapshot-at-suspension, resolver/dispatcher, boot recoverer → `paused`, user-gated continue that
reconciles against the JSONL ledger); explicit `kill -9` crash verification is **deferred to
dogfooding**, not a gate.

# Notes

- No durability for fast intra-segment effects: on a mid-segment crash, re-run the segment
  and accept a rare double inject/spawn. Idempotency keys are a future lever, out of scope.
- Edit-resilience: state is additive/optional with a `stateVersion` field for the rare
  migration; never remove a phase value a live run might be parked in.
- This task builds the full durable machinery but stops there — do not pile on more SDK or UI.
  The gate is the happy-path run verified via the `workflow_runs` row/logs; explicit `kill -9`
  crash testing is deferred to dogfooding.

# Reference

Deep context in `agent-workflows-design-notes`:

- §3 Execution model — `suspend`/`cont`, the "compute next state from the event payload" rule,
  serializable continuations.
- §4 Reference code — the `step`-function sketch this engine must run.
- §6 Durability model — snapshot-at-suspension vs Temporal, the delta, the worked crash
  walkthrough, where retryability comes from.
- §9 Codebase findings — the `workflow_runs` seam, the `InternalRuntimeEventBus`.
