---
title: Worktree Continuity
status: active
created: 2026-05-28
updated: 2026-05-29
tags: [mvp, worktrees, continuity, desktop, agents]
---

# Summary

Make each project checkout/worktree feel like a complete resumable environment, not just a folder on disk.

Isagi should let the user move between projects and worktrees while restoring the relevant agent sessions, command processes, browser/code/artifact surfaces, panel/window layout, and attention signals for that worktree.

# Why this matters

Worktrees are powerful, but today the surrounding work environment does not follow them. The user has to manually recreate context across terminals, agents, dev servers, browser tabs, VS Code windows, logs, artifacts, commits, and review surfaces.

The core pain is not creating a worktree. The pain is that switching a worktree means switching every ancillary app and process by hand.

This milestone proves Isagi's first value: preserving momentum by making worktree environments resumable.

# Direction

Build the first usable Isagi workspace around these primitives:

1. Global/user config
2. Project
3. Worktree / checkout
4. Environment
5. Command
6. Surface / panel
7. Attention signal

A worktree/checkouts's environment may include:

- first-class agent sessions
- project commands and command logs
- browser panes
- code-server / VS Code-like browser surfaces
- file or Markdown artifact panes
- main and secondary window layout state
- attention state indicating when an agent needs the user

The implementation should stay flexible. This milestone defines product direction and validation goals, not rigid internal architecture.

Isagi is expected to be a desktop app with a server/client architecture: Electron is the client, while a local/server runtime owns Git/worktree operations, process/PTY management, agent session lifecycle, state, and future remote execution possibilities.

# Done condition

Done enough means the user can dogfood Isagi for real work and can:

1. Add multiple projects.
2. See the main checkout and worktrees as first-class environments.
3. Create a new worktree from the command palette.
4. Initialize a new worktree from a project-level default template or equivalent behavior.
5. Launch an agent session in a worktree.
6. Run project commands in the active worktree.
7. Open browser/code/artifact surfaces attached to the worktree environment.
8. Switch to another worktree or project and restore that environment's state.
9. See when an agent session needs human attention.

# Boundaries

## In direction

- Multi-project from day one.
- Worktrees/checkouts as the main continuity unit.
- Main checkout treated as first-class, but non-closable root checkout.
- Tasks remain implicit/user-owned; Isagi does not need a first-class task model yet.
- New worktrees initialize from a project template or equivalent default environment.
- Existing worktrees restore their previous environment state.
- Commands are just terminal commands, not rigid command types.
- Commands are non-persistent by default.
- Commands may opt into persistence when the user/project knows they are safe to keep alive.
- Isagi should rediscover Git/worktree truth where possible instead of over-owning persistent state.
- Agent sessions are first-class even if internally they share process/PTY machinery with commands.
- Waiting-for-user detection is critical, but the detection method is exploratory.
- Main window plus secondary work surface is the preferred first compromise for two-monitor workflows.

## Out of direction for this milestone

- Fully arbitrary multi-window/split/tab workspace manager.
- Deep child-agent orchestration visibility.
- Dynamic MCP/tool/context control as a complete system.
- Durable archival of all command logs.
- Perfect cross-harness session resume.
- First-class task/milestone management inside Isagi.
- VS Code-native integration if code-server/browser-backed review is enough.

# Continue with

Use vertical slices rather than layer-first implementation tasks. Each slice should make Isagi more usable as the final product, even if it touches UI, server runtime, config, state, Git, and processes together.

Suggested sequence:

1. Experience mockups / interaction validation
   - Explore the project/worktree sidebar, main agent surface, side panels, secondary window, command palette, and attention badges.
   - Validate the feel before building functionality.

2. Project/worktree navigation slice
   - Register projects, discover worktrees, show them as navigable rooms, and switch active context across projects.

3. Create new worktree slice
   - Command palette flow: New worktree -> branch/name -> Git-created worktree -> land in initialized room.

4. First agent session slice
   - Launch an agent harness in a worktree, stream terminal output, remember the session association, and restore the visible association when switching back.
   - Basic launch support should target Pi, OpenCode, Claude Code, and Codex; deeper state/resume support can vary by harness.

5. Command/process slice
   - Define/run named project commands in the active worktree, show logs, and explore persistent vs non-persistent command lifecycle.

6. Browser/code/artifact surface slice
   - Attach browser panes, file/Markdown artifact panes, and code-server-like review surfaces to the worktree environment.
   - Explore local URL detection/inference without hard-coding a single implementation path.

7. Secondary work surface slice
   - Support a practical two-window model: main window for navigation + agent; secondary window for browser/code/artifact review.

8. Attention signal slice
   - Explore and implement reliable enough waiting-for-user detection for agent sessions.
   - Surface attention in the sidebar/session/worktree navigation.

9. Dogfood + tighten
   - Use Isagi on Isagi or another real project with multiple projects/worktrees, agents, commands, surfaces, secondary window, and attention signals.
   - Tighten based on real friction.

# Notes

Important product principle:

> Isagi starts conservative, but eagerly lets power users make environments feel alive.

Practical implications:

- Non-persistent command behavior is the safe default.
- Persistent commands are explicit.
- If a persistent command fails due to fixed ports or global resources, Isagi should surface the failure instead of trying to magically fix the project.
- Project-level configuration and future config-assistant skills should explain this tradeoff clearly.

Agent session resume should degrade gracefully. Isagi should resume specific sessions when harnesses support it, but the milestone should not depend on perfect session resume across all harnesses.
