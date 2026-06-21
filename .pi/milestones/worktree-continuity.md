---
title: Worktree Continuity
status: paused
created: 2026-05-28
updated: 2026-06-21
tags: [worktrees, continuity, surfaces, desktop]
---

# Summary

Complete the worktree-continuity vision by extending the resumable environment to the
surface kinds the base did not ship yet: browser panes, file/Markdown artifact panes, and
a practical secondary window for two-monitor review.

The resumable base shipped and is dogfoodable — see `worktree-continuity-base`. This
milestone rounds it out so a worktree environment can hold *what you look at*, not just its
agent and terminal surfaces.

# Why this matters

The original continuity bet — switch worktree, restore its environment — is proven for
agent and terminal surfaces. But real review work also lives in browsers, rendered
artifacts, and a second monitor. Until those are first-class, the user still drops out of
Isagi to juggle browser tabs and windows by hand — the exact friction continuity is meant
to remove.

Code-server / editor-backed *code review* is intentionally not here; it graduated into its
own milestone (`plan-and-code-review`). This milestone owns the generic surface substrate
and placement those review flows will sit on.

# Direction

Two deferred slices, both vertical:

1. Browser and file/Markdown artifact surfaces — open, associate with the active worktree,
   restore on return, and show an honest missing state.
   (`worktree-continuity-surfaces`)
2. Secondary work surface — a single secondary window with per-surface, user-driven popping
   (including agent/terminal surfaces), restored per worktree.
   (`worktree-continuity-secondary-surface`)

Surfaces are runtime-owned worktree view-state, consistent with the base. The PTY baseline
persists only `agent`/`terminal` kinds today; this milestone extends the runtime surface
model to `browser`/`file` (and the `editor` substrate consumed by `plan-and-code-review`)
when those become real, rather than relying on mock-only frontend fields.

# Done condition

Done when a worktree environment can open browser and file/Markdown artifact surfaces,
restore them on return with a clear missing state, and the user can pop surfaces into a
single secondary window whose placement restores per worktree.

# Boundaries

## In direction

- Browser panes and file/Markdown artifact panes as first-class worktree surfaces.
- One secondary window; per-surface, user-driven placement (no automatic bulk move).
- Restore surface state and secondary placement per worktree.

## Out of direction

- Fully arbitrary multi-window / freeform split workspace manager.
- Code-server / editor code-review workflow (now `plan-and-code-review`).
- Port→browser-surface auto-binding (parked; port chips stay display-only for now).

# Continue with

Deferred by choice — pick this up after dogfooding the base long enough to know which
review friction actually hurts most. Suggested order:

1. `worktree-continuity-surfaces` — browser + artifact surfaces.
2. `worktree-continuity-secondary-surface` — secondary window (depends on surfaces).

# Notes

Do not silently close missing artifacts — show a clear missing/not-found state.

Split out of the original Worktree Continuity milestone on 2026-06-21. The delivered,
dogfoodable base is recorded in `worktree-continuity-base`; code review graduated to
`plan-and-code-review`.
