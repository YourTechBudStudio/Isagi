---
title: Browser and artifact surfaces slice
status: todo
milestone: worktree-continuity
created: 2026-05-29
updated: 2026-05-29
depends_on: [worktree-continuity-command-runner]
---

# Outcome

Make browser and file/Markdown artifact surfaces part of the worktree environment.

# Context

Supporting surfaces are central to Worktree Continuity. Existing worktrees should restore their previous surface state. New worktrees should initialize from project defaults or equivalent template behavior.

Surface types for this slice include browser panes and file/Markdown artifact panes. Local HTTP surfaces may be inferred from command output, process behavior, or configured hints; the exact detection approach is flexible.

# Done condition

Done when browser panes and file/Markdown artifact panes can open, associate with the active worktree, restore when returning to that worktree, and show a missing state when a restored artifact path is unavailable.

# Notes

Do not silently close missing artifacts. Show a clear missing/not-found state and let copy/design be refined later.
