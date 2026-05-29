---
title: Create new worktree slice
status: todo
milestone: worktree-continuity
created: 2026-05-29
updated: 2026-05-29
depends_on: [worktree-continuity-project-worktree-navigation]
---

# Outcome

Create a new Git worktree from inside Isagi and land in its initialized room.

# Context

The target flow is command-palette driven: Cmd+K -> New worktree -> branch/name -> Git-created worktree -> active worktree room. Isagi should manage worktrees directly through Git rather than depending on external tools like WTP.

New worktrees should initialize from a project default template or equivalent default environment behavior.

# Done condition

Done when a user can create a new worktree from the UI, the worktree appears in navigation, Isagi switches into it, and the initialized room is ready for agent/session/command work.

# Notes

Keep project inference simple at first: default to the current project context, with room to make project selection more flexible later.
