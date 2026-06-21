---
title: Worktree Continuity app spine
status: completed
milestone: worktree-continuity-base
created: 2026-05-29
updated: 2026-05-31
depends_on: [worktree-continuity-mockups]
---

# Outcome

Establish the minimal Electron-client plus server-runtime shape needed for later vertical slices.

# Context

Isagi is a desktop app, but Electron is the client rather than the whole app. The local/server runtime should eventually own Git/worktree operations, process/PTY management, agent session lifecycle, state, and future remote execution paths.

This task should create only enough spine to support the next slices. Avoid over-designing the architecture before the product loop is proven.

# Done condition

Done when a basic Isagi shell can start, the client can connect to the local runtime, and the empty workspace UI can render enough structure for project/worktree navigation work to begin.

# Notes

Keep this thin. The goal is not the final architecture; the goal is a usable substrate for vertical slices.
