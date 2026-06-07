---
title: Project and worktree navigation slice
status: completed
milestone: worktree-continuity
created: 2026-05-29
updated: 2026-06-07
depends_on: [worktree-continuity-app-spine]
---

# Outcome

Show projects and worktrees/checkouts as navigable rooms inside Isagi.

# Context

Worktrees/checkouts are the main continuity unit. Tasks remain implicit and user-owned. The main checkout should be first-class like other worktrees, except it is the non-closable root checkout.

Switching between worktrees in the same project and worktrees in different projects should feel equally cheap.

# Done condition

Done when Isagi can register projects from a typed root-checkout path, discover the main checkout and existing linked Git worktrees, show them in navigation, switch active worktree context, and remember the last active context directionally.

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
- Add project lives at the **rail top** (`Mod+N`) for this slice; New worktree moves to the create-worktree slice.
- Linked worktree membership is reconciled from Git; gone linked worktrees leave the normal rail, while a missing project root remains visible as a config-error project.

# Outcome (done)

The functional navigation slice is complete enough for the milestone:

- Projects can be registered from a typed root-checkout path.
- The runtime discovers the root checkout and linked Git worktrees.
- The workspace API returns runtime-backed project/worktree facts.
- The rail renders projects and worktrees as navigable rooms.
- Switching active worktree context is frontend-owned and persists for restart restoration.
- Missing project recovery is represented explicitly instead of hiding unavailable roots.

Verified against the codebase on 2026-06-07; root `pnpm check` passed.
