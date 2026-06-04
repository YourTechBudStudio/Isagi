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

## Signal design (decided during the Phase 1–7 shell build)

The visual language is built; this slice supplies the real detection behind it.

- **One calm dot**, mapped to `attention-*` design tokens: `working` (violet,
  slow breathe), `waiting` (cyan, soft glow — needs you), `idle` (grey/
  text-tertiary), `error` (red, reserved for genuine error).
- Each dot has a **dry tooltip** naming its state, so meaning isn't carried by
  hue alone (accessibility). Motion is calm — never a frantic spinner.
- Dots appear on **rail session rows** (and agent/terminal panes). Session-level
  attention should **aggregate** from its harnesses/processes.
- **Never auto-switch** the user. The "a session is now waiting → click to jump"
  **toast is deprioritized** (the rail dots are the primary signal) — defer it.
