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

## Surface model (decided during the Phase 1–7 shell build)

- **Surfaces are Isagi-session view-state.** The agent surface is owned by the
  session; non-agent surfaces (browser, code-server/editor, file/markdown,
  terminal) are *sourced from the worktree* but tracked per session as "what the
  user wants to look at here." Two sessions on one worktree may show different
  surfaces.
- **Surface kinds**: `agent`, `terminal`, `browser`, `editor` (code-server),
  `file`. `agent` and `terminal` are sibling **split-PTY surfaces** sharing one
  split/drag/resize mechanism (see the split-layout task + agent-sessions).
- **One surface fills the whole canvas** (no side panel); switching surfaces is
  instant. Navigation to a surface happens from the **nested rail** row.
- **Zen / full-screen per surface** hides app chrome and asks the host shell to
  quiet native chrome; the canvas morphs to fill the window; `Mod+K` still
  navigates, Esc exits. (Built in the shell.)
- **How surfaces open**: code-server via the action bar's "Open code-server";
  browser from a command's bound port — but the **port→browser-surface binding
  is parked** for now (port chips are display-only). File/Markdown peek later.
- Surfaces restore per worktree on return; missing artifact → clear missing state.
