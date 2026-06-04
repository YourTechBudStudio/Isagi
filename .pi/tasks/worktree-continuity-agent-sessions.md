---
title: First-class agent sessions slice
status: todo
milestone: worktree-continuity
created: 2026-05-29
updated: 2026-05-29
depends_on: [worktree-continuity-project-worktree-navigation]
---

# Outcome

Launch and view first-class agent sessions inside worktrees.

# Context

An agent session is process-backed, but product-modeled separately from generic commands. A worktree can have multiple agent sessions, with one remembered as last active.

Basic launch support should target Pi, OpenCode, Claude Code, and Codex. Deep resume/status behavior can be adapter-specific and exploratory.

# Done condition

Done when Isagi can launch an agent harness in the active worktree, stream terminal output, associate the session with that worktree, represent multiple sessions per worktree, and restore the last active session association when switching back.

# Notes

Agent session resume should degrade gracefully. Resume specific sessions when a harness supports it, but do not make the whole milestone depend on perfect session resume across all harnesses.

## Agents-tab layout is persistent worktree state

The Agents tab lays harnesses out in (at most) two columns. The layout is **user-arrangeable**, not just auto-derived from harness count:

- Harnesses can be **dragged between columns** (e.g. 1 in column A, 3 stacked in column B).
- Column widths and the heights of stacked harnesses are **resizable via draggable gutters**.
- New harnesses auto-distribute (balanced) as a starting point; the user can then rearrange.

This arrangement (column assignment + ordering + gutter sizes) is **per-worktree layout state and must persist** (DB/store), so returning to a worktree restores the same agent layout. Default when no saved layout exists = balanced auto-distribution. Decided during the Phase 3 canvas mockup; see the split-layout task and the staged split surface shell.

## One agent surface per session (holds multiple harnesses)

A session has **at most one agent surface** — its home. That single agent surface
can hold **one or more harness sessions**, laid out via the two-column split above.
Harnesses split *within* the one agent surface; a session never has more than one
agent surface. Non-agent surfaces (browser/editor/file) may still be multiple. A
Skip session has zero surfaces and shows the no-agent empty state. (Re-tightened
2026-06-02 after briefly allowing multiple agent surfaces.)

## Shared split mechanism with terminal surfaces

The agent surface and the **terminal surface** are sibling *split-PTY surfaces*: both
lay panes out in a split grid (agent panes = harnesses, terminal panes = shells) and
should share **one** split/drag/resize/persist mechanism. Build it once and apply it
to both. A session has ≤ 1 agent surface but may have several terminal surfaces, and a
terminal surface may split multiple shells (tmux/Ghostty-style). Decided Phase 4.
