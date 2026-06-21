---
title: Surface split / drag / resize layout
status: done
milestone: worktree-continuity-base
created: 2026-06-02
updated: 2026-06-21
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
- Persist the active pane when the user focuses a pane, not only the active
  surface. The first PTY slice stores `activePaneId`, but the frontend currently
  only persists surface selection because every surface has one pane.
- And the arrangement (layout tree + ordering + gutter sizes + collapsed state)
  **persists per worktree environment** and restores on return. Default when none
  saved = single leaf for the first pane or balanced auto-distribution when new
  split panes are added.

# Completion notes

Shipped one shared split-PTY layout mechanism for both agent and terminal surfaces:

- Split a pane right or down (palette + per-pane commands); the runtime inserts
  into the layout tree, merging same-axis siblings for a Ghostty-style arrangement.
- Resize column widths and stacked-pane heights via custom pointer-drag gutters;
  `setSplitWeights` persists normalized weights and flips the split to `manual`.
- New panes auto-distribute — same-axis splits equalize every boundary on add,
  and pruning re-normalizes on delete.
- Active pane persists on pane focus (worktree environment focus carries both
  `activeSurfaceId` and `activePaneId`) and restores on return.
- Layout tree, child ordering, and gutter weights persist per surface as
  schema-validated `layoutJson` and restore on return. Default is a single leaf
  for the first pane, with balanced distribution as panes are added.

Deliberate scope cuts for this slice:

- **Collapse is dropped.** No collapse API, geometry, or UI ships. The `collapsed`
  flag stays on the leaf schema and is persisted (always `false`), so the stored
  structure remains collapse-ready for a future slice with no migration — but the
  collapse parts of the done condition are intentionally not delivered here.
- **Split directions are right/down only** by decision; the contract still models
  `left`/`up` for a later slice.
- **Resize/drag is a custom pointer implementation**, not `react-resizable-panels`
  or `@dnd-kit` — chosen over a third-party dependency.

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
- Current runtime persistence already stores one-leaf layout JSON for each PTY
  surface. This task should extend that model rather than replacing it.
- Closing/deleting panes is deliberately separate from collapsing panes; use the
  PTY close/delete lifecycle task for destructive cleanup semantics.
