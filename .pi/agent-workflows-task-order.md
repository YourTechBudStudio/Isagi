# Agent Workflows — build order

Updated: 2026-06-21

Foundation-first with an early vertical proof. The hard gate is the **engine spine surviving a
mid-run `kill -9`** — do not invest past it until it passes.

## Order

1. [x] Harness instrumentation — `agent-workflows-harness-instrumentation` (Pi first)
2. [ ] Engine spine / restart-survival gate — `agent-workflows-engine-spine`  ← de-risk gate
3. [ ] Full `ctx` SDK + loading/invocation — `agent-workflows-sdk-and-invocation`
4. [ ] Reference implementation workflow (first dogfood) — `agent-workflows-reference-workflow`
5. [ ] Frontend surface — `agent-workflows-frontend-surface` (parallels 3–4; consumes their contracts)
6. [ ] Agent-facing tool — `agent-workflows-agent-facing-tool` (last; may split to a follow-up milestone)

## Notes

- 1 and 2 pipeline: instrumentation does Pi first so the spine can start before the other
  harnesses finish.
- 4 lands the real value (the user's copy-paste loop) before 5 polishes the UI; minimal UI is
  fine for the first dogfood.
- ADRs: new workflow-subsystem ADR with task 2; ADR 0007 update with task 1.
- Architecture decided during shaping: durable state machine (snapshot-at-suspension, not
  Temporal replay), ctx-as-activity, runtime-owned + restart-surviving, opaque state,
  surface-lockdown ownership. See the milestone file `agent-workflows`.
- Full design reference (reference code, durability deep-dive, codebase findings with file
  refs, decisions log, open questions): `agent-workflows-design-notes`.
