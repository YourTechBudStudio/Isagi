---
title: Workflow engine spine — durable state machine (restart-survival gate)
status: todo
milestone: agent-workflows
created: 2026-06-21
updated: 2026-06-21
depends_on: [agent-workflows-harness-instrumentation]
---

# Outcome

A durable workflow engine that runs a hardcoded reducer end-to-end against a real agent
session and resumes correctly after a mid-run runtime restart. This is the de-risk gate for
the whole milestone.

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
  `setOperatingPhase`) and a dev trigger to run one hardcoded callback.

Resume watermark: the engine stamps injection time T and resumes on the first `turn_start ≥ T`
then its `turn_end`. Build on Effect, in-process. Land the new subsystem ADR here (durable
state machine vs Temporal replay, opaque-state boundary, ctx-as-activity, suspend/resume).

# Done condition

Done when a trivial test workflow spawns a Pi session, injects a prompt, waits for `turn_end`,
reads the reply via `getConversationHistory`, and sets operating phase to done — AND a
`kill -9` of the runtime mid-wait results in the run resuming from its snapshot and finishing.
If this passes, the architecture is proven.

# Notes

- No durability for fast intra-segment effects: on a mid-segment crash, re-run the segment
  and accept a rare double inject/spawn. Idempotency keys are a future lever, out of scope.
- Edit-resilience: state is additive/optional with a `stateVersion` field for the rare
  migration; never remove a phase value a live run might be parked in.
- This task deliberately stops at the restart-survival proof. Do not pile on more SDK or UI
  until the gate passes.

# Reference

Deep context in `agent-workflows-design-notes`:

- §3 Execution model — `suspend`/`cont`, the "compute next state from the event payload" rule,
  serializable continuations.
- §4 Reference code — the `step`-function sketch this engine must run.
- §6 Durability model — snapshot-at-suspension vs Temporal, the delta, the worked crash
  walkthrough, where retryability comes from.
- §9 Codebase findings — the `workflow_runs` seam, the `InternalRuntimeEventBus`.
