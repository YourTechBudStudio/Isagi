---
title: Secondary work surface slice
status: todo
milestone: worktree-continuity
created: 2026-05-29
updated: 2026-06-12
depends_on: [worktree-continuity-surfaces]
---

# Outcome

Support the user's two-monitor workflow without building a fully arbitrary window manager.

# Context

The preferred v1 compromise is a main window plus a secondary work surface. The main window focuses on navigation and the active agent. The secondary window can hold browser/code/artifact review surfaces.

Fully freeform detachable windows, splits, and arbitrary composition are explicitly later.

# Done condition

Done when Isagi supports a practical secondary window/work surface, the secondary surface can hold browser/code/artifact tabs or equivalent surfaces, and its state is associated with/restored for the active worktree.

# Notes

Prefer a simple, understandable two-window model over a complex window manager.

## Per-surface popping (rollback of the binary auto-move model)

Earlier we considered a binary model where turning on the secondary window moved **all** non-agent surfaces there at once. **That is reverted.** Instead, the user **pops surfaces to the secondary window one at a time**, choosing which go where — and this includes **agent and terminal surfaces**, not just browser/code/file surfaces. There is no automatic bulk move. Keep it a single secondary window (not arbitrary multi-window), but surface placement within it is per-surface and user-driven. Decided 2026-06-01 during Phase 3; retightened after the PTY baseline allowed multiple agent and terminal surfaces per worktree.
