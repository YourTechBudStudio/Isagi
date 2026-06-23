---
title: Harness instrumentation — turn events + conversation capture
status: done
milestone: agent-workflows
created: 2026-06-21
updated: 2026-06-22
depends_on: []
---

# Outcome

The runtime emits clean per-turn lifecycle events and can reconstruct an agent's
conversation history, for all supported harnesses (Pi, Claude, Codex, OpenCode).

# Context

Today the harness-observation layer (`apps/runtime/src/agent-sessions/harness-observation`)
only derives attention states (idle/working/waiting/error) from a subset of hooks, written
as JSONL artifacts and projected on demand. The workflow engine needs two new things:

- **Turn boundaries:** new `turn_start` / `turn_end` runtime events, named distinctly from
  the attention `agent_session_changed` signal, so suspended workflows can resume on a
  completed turn. All four harnesses have stop-type events; the current observation just
  doesn't capture them all.
- **Conversation history:** capture assistant/user message **text** into the JSONL ledger,
  exposed via a single `getConversationHistory(session)` read (the workflow slices `.at(-1)`
  itself for the last message). Text only — no tool calls or tool results.

Prior research confirmed all harnesses can emit turn boundaries and log full history; this
task discovers the exact hooks and wires them. Spawn one explore agent per harness to
inventory hooks. Update ADR 0007 to reflect the expanded hook usage.

# Done condition

Done when, driving each harness by hand in a normal session, the runtime emits exactly one
`turn_start`/`turn_end` per turn and `getConversationHistory` returns the role-tagged text
history with no tool-call noise — verified per harness, with automated tests against recorded
JSONL fixtures. ADR 0007 updated.

# Notes

- Do **Pi first** — primary harness and currently weakest-instrumented (no `Stop` wired
  today; attention infers from a `pending` boolean). Landing Pi unblocks the engine-spine
  task before the other harnesses finish.
- Failure spots to design around: edge (`Stop`) vs level (`pending`/`status`) detection;
  "waiting" can mean blocked-on-permission-prompt, not turn-done; records carry only a string
  `recordedAt`, no sequence id; instrumentation is best-effort per ADR 0007.
- This layer is the foundation everything else reads — keep the `getConversationHistory`
  shape clean and harness-agnostic.

# Reference

Deep context in `agent-workflows-design-notes`:

- §8 Turn detection & the watermark — `turn_start`/`turn_end`, injection-timestamp watermark.
- §9 Codebase findings — the per-harness observation modules with their native events
  (Claude `Stop`, Codex `Stop`, Pi `pending`, OpenCode `status`), the JSONL ledger, and what's
  net-new (text capture, turn events).
- §10 Failure spots — heterogeneous turn signalling, `waiting` ambiguity, process-gated
  attention dot, best-effort hooks.
