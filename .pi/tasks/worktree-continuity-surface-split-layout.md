---
title: Surface split / drag / resize layout
status: todo
milestone: worktree-continuity
created: 2026-06-02
updated: 2026-06-02
depends_on: [worktree-continuity-agent-sessions, worktree-continuity-surfaces]
---

# Outcome

Let users arrange the panes inside a split-PTY surface, and persist that layout per worktree.

# Context

Deferred during the Phase 1–7 shell build. The **agent surface** and the
**terminal surface** are sibling *split-PTY surfaces*: both lay panes out in a
split grid (agent panes = harness sessions, terminal panes = shells). The shell
currently renders a simple auto-split (panes side by side, focused bright, the
rest dimmed); rearranging and resizing are not yet built.

This slice builds **one** mechanism shared by both surface kinds.

# Done condition

Done when, inside a split-PTY surface, the user can:

- **Drag panes between the two columns** (e.g. 1 in column A, 3 stacked in B).
- **Resize** via draggable gutters — column widths and stacked-pane heights.
- Have new panes **auto-distribute** (balanced) as a starting point.
- And the arrangement (column assignment + ordering + gutter sizes) **persists
  per worktree** and restores on return. Default when none saved = balanced.

# Notes

- Max two columns (per the experience design). A session has ≤ 1 agent surface
  but may have several terminal surfaces; a terminal surface may split multiple
  shells (tmux/Ghostty-style).
- Likely libraries: `react-resizable-panels` for gutters, `@dnd-kit` for drag —
  decide during implementation.
- Reference the staged `SplitPtySurface` auto-split shell as the current shared
  seam, plus the persistence note in the agent-sessions task.
