---
title: Create new worktree slice
status: done
milestone: worktree-continuity-base
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

Done when a user can create a new worktree from the UI, the worktree appears in navigation, Isagi switches into it, and the initialized room is ready for agent sessions and command work.

# Notes

Keep project inference simple at first: default to the current project context, with room to make project selection more flexible later.

## Palette wizard (decided during the Phase 1–7 shell build)

Worktree creation rides the **morphing command-palette wizard** (built
presentationally in the shell). Worktree creation and launch setup are unified:

- Steps: **project → worktree → harness**. The worktree step is a **combo**:
  pick an existing worktree *or type a name to create* `wt/<name>` (created via
  Git). Harness defaults to **Skip** (then Pi / Claude Code / Codex / OpenCode).
- Every step is **pre-defaulted**, so the common path is `Mod+N` then
  enter-enter-enter. Defaults are **worktree-optimized**: default project = the
  current project, default worktree = the current branch/current worktree
  (zero-typing to stay in the same worktree); a brand-new project should derive
  its default from Git/project context rather than assuming a `main` branch.
- The palette's **Global** commands are a config-driven, append-only registry;
  New worktree is the flagship multi-arg command. Arg `options`/`default`
  functions read a context snapshot from the workspace store. All defaults are
  overridable via project config.
- New worktrees initialize from project defaults (commands that auto-run, default
  surfaces).
