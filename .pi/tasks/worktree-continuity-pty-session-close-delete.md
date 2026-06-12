---
title: PTY session close/delete lifecycle
status: todo
milestone: worktree-continuity
created: 2026-06-12
updated: 2026-06-12
depends_on: [worktree-continuity-agent-sessions]
---

# Outcome

Let users explicitly stop, close, and delete PTY-backed agent/terminal panes and surfaces without hiding failures or leaking runtime log files.

# Context

The first PTY session slice keeps exited and failed sessions visible, which is the right honest default: a crashed agent or missing binary should leave evidence on the canvas instead of disappearing. That slice intentionally did not implement destructive lifecycle actions.

As soon as users dogfood multiple sessions, they need a way to clean up dead panes/surfaces and intentionally stop live sessions. Runtime logs also need a user-caused cleanup path so `.ptylog` files do not accumulate forever.

This task owns explicit close/delete semantics. It is separate from split-layout collapse: collapsed panes remain part of the surface and keep their session; deleted panes/surfaces remove user-visible state and clean up durable runtime artifacts.

# Done condition

Done when a user can:

- Stop/kill a running PTY session from its pane or surface controls.
- Close an exited/failed PTY pane or single-pane surface.
- Remove the associated DB rows and raw `.ptylog` file when the user explicitly deletes the session/surface.
- See honest confirmation/copy for destructive cleanup, especially if a session is still running.
- Return to the worktree without the deleted pane/surface reappearing.

# Notes

- Do not auto-delete failed/exited sessions on process exit. Keep the evidence until the user explicitly closes/deletes it.
- A single-pane surface can probably be deleted as a unit. Multi-pane surfaces should eventually support deleting one pane without deleting sibling panes.
- If log file deletion fails, the UI should not pretend cleanup fully succeeded; surface a warning and leave enough diagnostic context.
- Orphan `.ptylog` detection already exists as a diagnostic-only hardening pass. This task may add explicit cleanup for rows/logs caused by user deletion, but should not introduce broad silent startup GC.
- Destructive cleanup copy should be restrained and clear; no humour in destructive confirmations.
