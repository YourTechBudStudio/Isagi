---
title: Attention signals slice
status: todo
milestone: worktree-continuity
created: 2026-05-29
updated: 2026-05-29
depends_on: [worktree-continuity-agent-sessions]
---

# Outcome

Detect and surface when an agent session needs human attention.

# Context

Attention state is core to momentum. The most important signal is whether an agent has finished its turn and is waiting for the user. Worktree-level attention can aggregate agent session state and eventually command/process failures if useful.

Waiting detection is non-negotiable as a product goal, but the detection method is exploratory and may differ by harness.

# Done condition

Done when at least one reliable waiting-for-user path has been implemented or validated, sidebar/worktree/session attention indicators exist, and the state model has been refined based on what harnesses can expose.

# Notes

Possible states include running, waiting, idle-ish, exited, and error-ish, but exact names should be decided during implementation.
