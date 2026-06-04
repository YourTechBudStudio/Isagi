---
title: Project and worktree navigation slice
status: todo
milestone: worktree-continuity
created: 2026-05-29
updated: 2026-05-29
depends_on: [worktree-continuity-app-spine]
---

# Outcome

Show projects and worktrees/checkouts as navigable rooms inside Isagi.

# Context

Worktrees/checkouts are the main continuity unit. Tasks remain implicit and user-owned. The main checkout should be first-class like other worktrees, except it is the non-closable root checkout.

Switching between worktrees in the same project and worktrees in different projects should feel equally cheap.

# Done condition

Done when Isagi can register or discover projects, discover the main checkout and existing worktrees, show them in navigation, switch active worktree context, and remember the last active context directionally.

# Notes

Git/worktree truth should be rediscovered from Git where practical instead of treating Isagi's persisted state as the sole source of truth.

## Navigation shape (decided during the Phase 1–7 shell build)

The presentational shell (in `apps/web`) settled the navigation model. See the
built rail components and the slice notes below.

- **Nested rail, not top-level tabs.** Worktrees are grouped by project; the
  **active worktree expands inline** to show its surfaces as indented rows.
  Clicking a surface row swaps the canvas. Only the active worktree expands.
- **Hierarchy = accent spine + neutral lift**: one blue spine marks the active
  worktree's path (hue), the active surface gets a neutral light lift (lightness)
  — not two colored pills.
- **The worktree is the navigable unit.** Worktrees carry a calm **attention dot**;
  **parked** worktrees dim in place; grouping is always shown (even for a single
  project).
- **`activeSurfaceId` is remembered per worktree** and restored on switch-back —
  this is the resumable-room promise in miniature.
- New worktree lives at the **rail top** (`Mod+N`) plus a per-project `+`.
- Rail membership is curated (active + parked); `done` worktrees leave the rail.
