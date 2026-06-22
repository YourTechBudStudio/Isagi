---
title: Workflow frontend surface — rail, lockdown, controls, dynamic panes
status: todo
milestone: agent-workflows
created: 2026-06-21
updated: 2026-06-21
depends_on: [agent-workflows-engine-spine]
---

# Outcome

A running workflow is visible and controllable in the client: operating phase, surface
lockdown, pause/cancel/continue, dynamically-appearing panes, and palette invocation with
rendered args.

# Context

The runtime owns workflow run state; this task surfaces it (ADRs 0001/0008 for state ownership
and read composition, 0003 for palette, 0004 for action feedback; design-system skill for the
visual language). New contracts in `packages/contracts` for run status / operating phase /
attention. Likely fans out into several tasks during its own brainstorm (rail, lockdown,
controls, dynamic panes, palette args).

Ownership model: a running workflow is scoped to a surface; the surface **locks input while
the run is `running`** and unlocks on `waiting`/`done`/`failed` — this is the human/workflow
collision arbitration. Controls: `pause` (unlock + stop injecting), `cancel` (end the run),
`continue` (resume from a waiting state).

Can start once the engine spine exists (run status is available) and parallels the SDK /
reference-workflow tasks, consuming their contracts as they land.

# Done condition

Done when, with a workflow running, the user can see the operating phase on the rail, the
surface locks input while running and unlocks on waiting/done, the three controls behave,
spawned panes appear, and the command palette renders the workflow's declared args for
invocation.

# Notes

- Richness is a dial: minimal (status + lock + three controls) up to the full
  floating-action-bar vision. Set it based on what the reference-workflow dogfood reveals.
- Replaces the API stand-ins used to test the human-interaction SDK verbs.

# Reference

Deep context in `agent-workflows-design-notes`:

- §11 Ownership, lockdown, controls — run-status → surface lock, the three controls.
- §9 Codebase findings — ADR map (0001/0008 state ownership, 0003 palette, 0004 feedback).
