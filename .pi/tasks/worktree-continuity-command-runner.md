---
title: Command runner slice
status: todo
milestone: worktree-continuity
created: 2026-05-29
updated: 2026-05-29
depends_on: [worktree-continuity-project-worktree-navigation]
---

# Outcome

Run named project commands inside the active worktree and make their output inspectable.

# Context

Commands are just terminal commands. Isagi should not require users to classify commands as dev servers, test watchers, linters, databases, or short/long-running processes.

Commands are non-persistent by default. Users/projects may opt commands into persistence when they know the command is safe to keep alive across worktree switches.

# Done condition

Done when project commands can be defined minimally, run in the correct worktree, show logs/output, and support or prototype the persistent vs non-persistent lifecycle direction.

# Notes

If a persistent command fails due to fixed ports or global resources, Isagi should surface the failure rather than magically fixing project-level misconfiguration.
