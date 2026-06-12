---
title: Project Settings
status: candidate
created: 2026-06-08
updated: 2026-06-12
tags: [candidate, settings, projects, trust, config]
---

# Summary

Give each project a dedicated settings surface for project-scoped configuration, including worktree hook trust controls.

This should make project-specific behavior visible and adjustable without confusing it with Isagi's global runtime data directory at `$HOME/.isagi`.

# Why this matters

As Isagi grows beyond basic worktree discovery, project behavior will increasingly come from project-scoped configuration such as `.isagi/config.yaml`: worktree bootstrap hooks, commands, default surfaces, launch preferences, and future project conventions.

That power needs a place where users can understand and adjust what a project is allowed to do. Worktree hooks especially introduce trust decisions: a project may run shell commands, copy files, and create symlinks when a new checkout is created. The user should not have to remember which hook config was trusted, whether a project is always trusted, or whether hooks were disabled.

The value is not a generic settings dump. The value is making project-specific operational behavior legible and reversible.

# Direction

Explore a project settings surface that can show and eventually edit project-scoped configuration.

Initial setting areas may include:

- project identity and root path
- project-scoped `.isagi/config.yaml` status
- worktree hook trust state
  - trusted hook config version/hash
  - always trust this project
  - hooks disabled for this project
  - reset/revoke trust decisions
- worktree bootstrap hook summary
- future project commands/defaults once those exist
- future default shell/runtime launch preferences, likely with global defaults
  and project overrides only where projects prove they need them
- future PTY/runtime lifecycle tuning, including configurable status polling and backend GC intervals with safe defaults
- future agent harness launch commands/flags for Pi, OpenCode, Claude, Codex,
  and any later harnesses

For the worktree hook trust model, settings should complement the command-palette approval flow. The palette can ask at the moment of worktree creation; the settings page should let the user inspect and change that decision later.

# Done condition

Not hardened yet.

A future milestone may be ready when we know:

- which project settings exist by the time the first dogfood loop needs this surface
- whether project settings are read-only, editable, or partly editable
- how trust state is represented in the runtime database and surfaced to the UI
- how settings distinguish project-local config from global Isagi runtime/user state
- what minimal settings UI reduces support/debugging friction without becoming a configuration IDE

# Boundaries

Keep this focused on project-scoped settings. Global app preferences, runtime data-directory management, and account/billing-style settings belong elsewhere.

Do not make this block the first worktree bootstrap hooks implementation. Hook trust can start in the command palette; this milestone captures the later management surface.

Do not turn Isagi into a full YAML editor or secret manager. Editing `.isagi/config.yaml` from the app may be useful later, but the first value is visibility and trust control.

# Continue with

After worktree bootstrap hooks exist or are close to implementation, run discovery on:

1. The minimal project settings IA: where the surface lives and how users reach it.
2. The trust-control UI for hook config versions, always-trust, and disabled-hooks states.
3. The runtime API shape for reading/updating project settings and trust decisions.
4. Whether `.isagi/config.yaml` should be shown as parsed summaries, raw YAML, or both.
5. Which future project config areas should be parked vs included in the first settings slice.

# Notes

Created during the worktree bootstrap hooks brainstorm. The immediate hook feature needs command-palette trust approval; this milestone preserves the follow-up need for a settings page where those decisions can be reviewed and changed.

During the agent/terminal PTY brainstorm, default shell selection and harness
launch commands were parked as settings follow-ups. The first PTY slice should
use `$SHELL` with `bash` fallback for terminals and built-in harness commands
(`pi`, `opencode`, `claude`, `codex`) for agents.
