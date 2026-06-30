# Agent Workflows — build order

Updated: 2026-06-30

Foundation-first with an early vertical proof. The engine spine is built **durable-by-design**;
its gate is a working end-to-end run verified via the `workflow_runs` row/logs, with explicit
`kill -9` crash verification deferred to dogfooding (after the first real workflow). Later tasks
proceed on a durable-by-construction basis.

## Order

1. [x] Harness instrumentation — `agent-workflows-harness-instrumentation` (Pi first)
2. [x] Engine spine / restart-survival gate — `agent-workflows-engine-spine` ✓ de-risk gate passed
3. [x] Full `ctx` SDK + loading/invocation — `agent-workflows-sdk-and-invocation`
4. [x] Reference implementation workflow (first dogfood) — `agent-workflows-reference-workflow`
5. [ ] Workflow author guide — `agent-workflows-writer-docs` (after 3–4; → later an agent skill; off the critical path)
6. [x] Frontend surface — `agent-workflows-frontend-surface` (parallels 3–4; consumes their contracts) ✓ all 5 phases landed
7. [ ] Agent-facing tool — `agent-workflows-agent-facing-tool` (last; may split to a follow-up milestone)

## Notes

- 1 and 2 pipeline: instrumentation does Pi first so the spine can start before the other
  harnesses finish.
- The reference workflow (4) lands the real value (the user's copy-paste loop) before the
  frontend surface polishes the UI; minimal UI is fine for the first dogfood.
- Writer docs (5) are off the critical path: they need the final SDK (3) and use the reference
  workflow (4) as the canonical sample, so they can be written alongside the frontend and later
  promoted to an agent skill.
- Docs/ADRs: new workflow-subsystem **design doc** (`docs/workflow-engine.md`) with task 2;
  ADR 0007 update with task 1.
- Architecture decided during shaping: durable state machine (snapshot-at-suspension, not
  Temporal replay), ctx-as-activity, runtime-owned + restart-surviving, opaque state,
  surface-lockdown ownership. See the milestone file `agent-workflows`.
- Full design reference (reference code, durability deep-dive, codebase findings with file
  refs, decisions log, open questions): `agent-workflows-design-notes`.
