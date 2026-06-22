---
title: Agent-facing "run a workflow" tool
status: todo
milestone: agent-workflows
created: 2026-06-21
updated: 2026-06-21
depends_on: [agent-workflows-sdk-and-invocation]
---

# Outcome

An agent can invoke a workflow through an injected tool and receive its result, even across a
runtime restart between the call and the result.

# Context

The tool injects via the existing per-invocation plugin/extension mechanism (ADR 0007) —
injection is the easy part. The hard part is the return: a workflow can run for hours and must
survive restarts, which a synchronous blocking tool call can't. Default approach: the tool
returns a run handle immediately, the calling agent ends its turn, and the workflow delivers
its result by injecting a new turn into that agent when done (async result-injection) — which
fits the suspend/resume model and is restart-robust. Blocking-mode and a two-tool
(spawn + wait) split are fallbacks.

Last task in the milestone; may split off into its own follow-up milestone. Decide the return
mechanism after using the system, not before.

# Done condition

Done when an agent calls the `run_workflow` tool, ends its turn, and the result arrives as a
new injected turn — surviving a runtime restart between the call and the result.

# Notes

- The workflow ID must be supplied explicitly (by the user or a skill), per the original
  intent — the tool itself stays thin.
- Most likely part to be reshaped by real usage; don't over-design.

# Reference

Deep context in `agent-workflows-design-notes`:

- §12 Decisions — the agent-tool return-mechanism options (blocking flag / two-tool spawn+wait
  / async result-injection) and why we lean async result-injection.
