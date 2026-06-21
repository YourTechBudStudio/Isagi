---
title: Attention signals slice
status: done
milestone: worktree-continuity-base
created: 2026-05-29
updated: 2026-06-18
depends_on: [worktree-continuity-agent-sessions]
---

# Outcome

Detect and surface when an agent session needs human attention.

# Context

Attention state is core to momentum. The most important signal is whether an agent has finished its turn and is waiting for the user. Worktree-level attention can aggregate agent session state and eventually command/process failures if useful.

Waiting detection is non-negotiable as a product goal, but the detection method is exploratory and may differ by harness.

# Done condition

Done when at least one reliable waiting-for-user path has been implemented or validated, sidebar/worktree/agent-session attention indicators exist, and the state model has been refined based on what harnesses can expose.

# Completion

Completed with file-backed harness observation and runtime-owned attention projection.
Pi, OpenCode, Claude, and Codex now write harness event logs and project agent
attention into pane, surface, and worktree indicators. Waiting detection is live
for Pi, OpenCode, Claude, and Codex, with Claude/Codex currently treating `Stop`
as waiting based on product testing.

# Notes

Possible states include running, waiting, idle-ish, exited, and error-ish, but exact names should be decided during implementation.

## Signal design (decided during the Phase 1–7 shell build)

The visual language is built; this slice supplies the real detection behind it.

- **One calm dot**, mapped to `attention-*` design tokens: `working` (violet,
  slow breathe), `waiting` (cyan, soft glow — needs you), `idle` (grey/
  text-tertiary), `error` (red, reserved for genuine error).
- Each dot has a **dry tooltip** naming its state, so meaning isn't carried by
  hue alone (accessibility). Motion is calm — never a frantic spinner.
- Dots appear on **rail worktree rows** (and agent/terminal panes). Worktree-level
  attention should **aggregate** from its harnesses/processes.
- **Never auto-switch** the user. The "a worktree is now waiting → click to jump"
  **toast is deprioritized** (the rail dots are the primary signal) — defer it.

## PTY baseline follow-ups

The first PTY session slice persists surface/pane/session attention and renders pane-level dots, but the next attention pass should make the rail honest and useful:

- Aggregate PTY session lifecycle state into worktree-level attention instead of leaving worktrees effectively idle.
- Show surface-level attention on rail surface rows so running/error agent and terminal surfaces are visible before opening them.
- Refresh or patch workspace surface metadata when a visible PTY exits/fails so rail state does not stay stale until an unrelated refetch.
- Keep lifecycle attention (`working`, `idle`, `error`) separate from harness-specific waiting-for-user detection; waiting detection remains the product-critical part of this task.
