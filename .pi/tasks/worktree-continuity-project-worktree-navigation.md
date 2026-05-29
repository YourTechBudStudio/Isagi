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
