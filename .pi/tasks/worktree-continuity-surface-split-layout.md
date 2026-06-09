---
title: Surface split / drag / resize layout
status: todo
milestone: worktree-continuity
created: 2026-06-02
updated: 2026-06-09
depends_on: [worktree-continuity-agent-sessions, worktree-continuity-surfaces]
---

# Outcome

Let users arrange the panes inside a split-PTY surface, and persist that layout as worktree environment state.

# Context

Deferred during the Phase 1–7 shell build. **Agent surfaces** and
**terminal surfaces** are sibling *split-PTY surfaces*: both lay panes out in a
split layout (agent panes = harness sessions, terminal panes = shells). The shell
currently renders a simple auto-split (panes side by side, focused bright, the
rest dimmed); rearranging and resizing are not yet built.

This slice builds **one** mechanism shared by both surface kinds.

# Done condition

Done when, inside a split-PTY surface, the user can:

- **Split panes horizontally or vertically** into a Ghostty-style layout.
- **Resize** via draggable gutters — column widths and stacked-pane heights.
- Have new panes **auto-distribute** (balanced) as a starting point.
- **Collapse panes** without deleting the pane or its session; collapsed panes
  restore when expanded.
- And the arrangement (layout tree + ordering + gutter sizes + collapsed state)
  **persists per worktree environment** and restores on return. Default when none
  saved = single leaf for the first pane or balanced auto-distribution when new
  split panes are added.

# Notes

- A worktree may have multiple agent surfaces and multiple terminal surfaces.
  User-started `Start agent session` / `Start terminal` creates a new surface
  with one pane; orchestrator-spawned child agents may later insert panes into
  the originating surface.
- Persist layout as a tree. Leaf nodes reference panes. Split nodes record axis
  (`row` or `column`), child nodes, sizing mode (`auto` or `manual`), and
  weights. This keeps V1 single-pane surfaces compatible with future nested
  split layouts.
- Likely libraries: `react-resizable-panels` for gutters, `@dnd-kit` for drag —
  decide during implementation.
- Reference the staged `SplitPtySurface` auto-split shell as the current shared
  seam, plus the persistence note in the agent-sessions task.
