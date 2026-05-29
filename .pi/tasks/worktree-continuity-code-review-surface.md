---
title: Code review surface slice
status: todo
milestone: worktree-continuity
created: 2026-05-29
updated: 2026-05-29
depends_on: [worktree-continuity-surfaces]
---

# Outcome

Explore a VS Code-like review surface for inspecting worktree code without manually managing VS Code windows.

# Context

Reviewing code is a core part of the user's workflow. VS Code is folder-sensitive, and manually juggling VS Code instances across worktrees creates friction.

Code-server or a similar browser-backed editor may be treated as a high-value browser-backed surface. The exact implementation can be decided during this task.

# Done condition

Done when there is a usable path for reviewing the active worktree's code from Isagi, even if final code-server semantics remain flexible.

# Notes

This may be implemented as command + browser surface, a first-class code-server integration, or another pragmatic approach discovered during the task.
