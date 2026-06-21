---
title: First-class agent sessions slice
status: done
milestone: worktree-continuity-base
created: 2026-05-29
updated: 2026-06-12
depends_on: [worktree-continuity-project-worktree-navigation]
---

# Outcome

Launch and view first-class agent sessions inside worktrees.

# Context

An agent session is process-backed, but product-modeled separately from generic commands. A worktree can have multiple agent sessions, each backed by a PTY pane in an agent surface.

Basic launch support targets Pi, OpenCode, Claude Code, and Codex. Deep resume/status behavior can be adapter-specific and exploratory.

# Done condition

Done when Isagi can launch an agent harness in the active worktree, stream terminal output, associate the session with that worktree, represent multiple sessions per worktree, and restore the last active session association when switching back.

# Completion notes

Implemented in the first PTY session slice:

- Runtime-owned PTY substrate using `node-pty` behind an adapter boundary.
- Agent launch support for `pi`, `opencode`, `claude`, and `codex`.
- Terminal launch support using `$SHELL` with `bash` fallback.
- Runtime DB persistence for worktree surfaces, panes, PTY sessions, and per-worktree active surface/pane focus.
- File-backed raw PTY logs under the runtime data directory's `sessions/` folder.
- Per-visible-session WebSocket attach with full log replay and live streaming.
- Frontend xterm rendering with WebGL fallback.
- Worktree-scoped palette actions: `Start agent session` and `Start terminal`.

# Notes

Agent session resume should degrade gracefully. Runtime restart survival is not part of this completed baseline: if the runtime restarts, persisted running sessions are marked failed with an honest synthetic log note. A future tmux/supervisor adapter can revisit runtime-restart survival.

## Multiple agent surfaces per worktree

The earlier "one agent surface per worktree" rule has been reverted. A worktree may have multiple agent surfaces and multiple terminal surfaces.

Current user-started behavior:

- `Start agent session` always creates a new agent surface with one pane.
- `Start terminal` always creates a new terminal surface with one pane.

Future orchestrator-spawned child agents may insert panes into the originating agent surface instead of creating new surfaces; that belongs with child-agent visibility and split-layout work.

## Pane-aware surface model

Sessions bind to panes, not directly to surfaces:

```txt
worktree
  -> worktree_surfaces
      -> surface_panes
          -> pty_sessions
```

This keeps the completed single-pane baseline compatible with future split surfaces.

## Shared split mechanism with terminal surfaces

Agent surfaces and terminal surfaces are sibling split-PTY surfaces. The completed baseline renders one pane per newly created surface. Split, drag, resize, collapse, active-pane persistence, and multi-pane arrangement belong to the split-layout task.

## Follow-ups intentionally left out

- Close/kill/delete lifecycle for PTY-backed panes and their log files.
- Waiting-for-user detection and rail/worktree attention aggregation.
- Split/drag/resize/collapse UI.
- tmux-backed or supervisor-backed adapter POC.
- Harness launch command/flag customization.
