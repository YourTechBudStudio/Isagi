---
title: Command runner slice
status: todo
milestone: worktree-continuity
created: 2026-05-29
updated: 2026-06-12
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

## Commands vs. terminals (decided Phase 4)

Commands and interactive terminals split along **monitor vs. work**:

- A **command** is a managed process you **monitor** — a dev server, a test watcher. It exposes logs, ports, and run/stop, and lives in the right-hand **workbench drawer** (commands-only master-detail). You rarely type into it.
- A **terminal** is an interactive shell you **work in**. Terminals are **not** commands — they are first-class **terminal surfaces** on the canvas (siblings of the agent surface), out of scope for this slice.

So this slice owns the command lifecycle, logs, ports, and the drawer/status-strip presentation — not ad-hoc terminals. Port→browser-surface binding is parked (port chips are display-only for now).

## Presentation (decided during the Phase 1–7 shell build)

The UI is built presentationally; this slice wires real processes behind it.

- **Commands are worktree-scoped** (project-configured; some auto-run on new
  worktree). Modeled as the worktree's command view.
- **Status strip** (always-on, bottom): the worktree's running/failed commands
  sit beside each other — dot + name + **port chips (no port names)** — with the
  branch on the right. Clicking the strip opens the commands drawer; clicking a
  command name jumps to its logs. Left intentionally free for future status.
- **Workbench drawer**: commands-only **master-detail**, a **full-height** panel
  sliding from the right, **resizable**, with an expand-to-full-width toggle and
  Esc / click-outside dismiss (no close button). Run/stop/restart per command;
  **exited/crashed logs are retained**.
- Openers will be the action bar + palette ("Open commands").

## Relationship to the PTY session substrate

The first agent/terminal slice introduced runtime-owned PTY sessions and file-backed logs for interactive work surfaces. Command runner should reuse the lessons and possibly some low-level process/logging primitives where appropriate, but should not turn commands into terminal surfaces by default.

Commands remain monitor-oriented: run/stop/restart, retained logs, ports, status strip, and drawer presentation. Interactive shells remain terminal surfaces.
