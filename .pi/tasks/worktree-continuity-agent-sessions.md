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
