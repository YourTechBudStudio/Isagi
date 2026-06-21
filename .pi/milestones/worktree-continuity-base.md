---
title: Worktree Continuity — Base (dogfoodable v1)
status: completed
created: 2026-05-28
updated: 2026-06-21
tags: [mvp, worktrees, continuity, desktop, agents]
---

# Summary

Make each project checkout/worktree feel like a complete resumable environment, not just
a folder on disk.

This is the delivered, dogfoodable base of Worktree Continuity: the user can move between
projects and worktrees while Isagi restores the relevant agent sessions, command
processes, split layout, surface selection/focus, and attention signals for that worktree.

# Why this matters

Worktrees are powerful, but the surrounding work environment did not follow them. The pain
was never creating a worktree — it was that switching a worktree meant recreating every
ancillary process and surface by hand.

This milestone proved Isagi's first value: preserving momentum by making worktree
environments resumable. With the base shipped, Isagi is usable for real work.

# Direction (as built)

Built around these primitives: global/user config, project, worktree/checkout,
environment, command, surface/panel, attention signal.

Delivered as vertical slices, each making Isagi more usable end-to-end:

- Project/worktree navigation across multiple projects.
- Create a new worktree from the command palette.
- First-class agent sessions on a runtime-owned PTY baseline (Pi, OpenCode, Claude, Codex).
- Named project commands with logs and persistent/non-persistent lifecycle.
- PTY session stop/close/delete lifecycle that keeps failure evidence honest.
- Attention signals from harness observation, surfaced in rail/surface/worktree.
- Split-PTY surfaces (agent + terminal) with split/resize and persisted layout + focus.
- Per-worktree restore of surfaces, panes, sessions, layout, and active pane on return.

# Done condition

Done enough means the user can dogfood Isagi for real work. Delivered:

1. Add multiple projects. ✓
2. See the main checkout and worktrees as first-class environments. ✓
3. Create a new worktree from the command palette. ✓
4. Initialize a new worktree from a project default/equivalent. ✓
5. Launch an agent session in a worktree. ✓
6. Run project commands in the active worktree. ✓
7. Switch to another worktree/project and restore that environment's state. ✓
8. See when an agent session needs human attention. ✓

Carved out of this base into follow-on milestones on 2026-06-21:

- Browser / file / Markdown artifact surfaces → `worktree-continuity`.
- Secondary work surface (two-monitor) → `worktree-continuity`.
- Code-server / editor code review → `plan-and-code-review`.

# Boundaries

## Held in scope (delivered)

- Multi-project from day one; worktrees as the continuity unit; non-closable root checkout.
- Tasks remain implicit/user-owned; no first-class task model.
- Commands are plain terminal commands, non-persistent by default, opt-in persistent.
- Rediscover Git/worktree truth where possible instead of over-owning state.
- Agent sessions first-class even when sharing PTY machinery with commands.
- Waiting-for-user detection critical; detection method exploratory.

## Deferred (now follow-on milestones)

- Browser/code/artifact surfaces and the secondary window (see carve-outs above).
- Fully arbitrary multi-window/split workspace manager.
- Deep child-agent orchestration visibility.
- Dynamic MCP/tool/context control as a complete system.
- Durable archival of all command logs.
- Perfect cross-harness session resume.

# Notes

Product principle that guided the base:

> Isagi starts conservative, but eagerly lets power users make environments feel alive.

Completing this base unparks the previously-gated candidate milestones:
`project-home-whats-next`, `context-preset-control`, `child-agent-visibility`.

The build order and per-slice notes are recorded in
`.pi/worktree-continuity-task-order.md`.
