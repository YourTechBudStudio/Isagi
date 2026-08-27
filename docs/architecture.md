# Architecture

## Architectural shape

Isagi is a desktop app with a server/client architecture.

Electron is the client. The core runtime is a server-style process that owns worktree, worktree-environment, process, PTY, agent-session, and persistence responsibilities.

This separation keeps the desktop experience local and direct while leaving room for remote execution later.

## Client

The Electron client owns the interactive workbench experience:

- project/worktree/surface navigation
- command palette
- main and secondary windows
- panels and tabs
- terminal rendering
- agent, terminal, browser, editor, and artifact surfaces
- command status and logs UI
- attention badges and status UI
- user interaction flows

The client should frame the work, not become the source of truth for runtime state.

## Server/runtime

The server/runtime owns the operational side of Isagi:

- Git and worktree operations
- project/worktree discovery
- worktree environment restoration state
- process management
- PTY management
- command execution
- agent session lifecycle
- runtime status
- state persistence
- integration boundaries with harnesses and future tool systems
- future remote execution path
- cached host inventory, harness launch policy, and explicit Docs reconciliation

The runtime is the place where Isagi understands what is running, where it is running, and which worktree/worktree environment it belongs to.

## Why server/client

A server/client architecture gives Isagi a cleaner boundary between UI and execution.

Benefits:

- Electron can remain focused on the desktop experience.
- Process and PTY handling can live outside UI concerns.
- Remote execution becomes possible without redesigning the product model.
- The same runtime concepts can support local and remote work later.
- Harness integrations can be isolated from the UI shell.

## Source-of-truth principle

Isagi should not over-own facts that already have a better source of truth.

In particular, Git should remain the source of truth for repository and worktree facts where possible. Isagi can remember projects, preferences, layout, and environment state, but it should rediscover real worktree state from Git instead of trusting stale app records blindly.

Users may create, move, or delete worktrees outside Isagi. The runtime should reconcile against those external facts rather than assuming Isagi is the only actor changing a repository.

## State categories

### Durable configuration

User and project preferences that should survive restarts.

Examples:

- global harness presets
- project command definitions
- project default worktree initialization behavior
- user preferences

### Rediscoverable repository state

Facts that should be read from Git or the filesystem where possible.

Examples:

- worktrees
- branches
- repository paths
- file existence

### Runtime process state

State that exists only while processes are alive.

Examples:

- running commands
- active PTYs
- live logs
- active agent processes
- resolved local HTTP URLs for running commands

If Isagi or the machine restarts, this state may be gone. Restoration means recreating or reopening the environment, not pretending child processes survived.

Resolved ports and URLs belong to the current running command incarnation. The runtime durably remembers each allocated endpoint's latest port only as a preference for a later launch; that persistence does not keep a process or URL alive and does not reserve the port.

### Restorable environment/UI state

State that helps recreate the user's room.

Examples:

- last active worktree
- last active surface within each worktree
- last active agent session metadata, where available
- panel/window layout
- open surfaces
- remembered artifact paths
- command history needed for restoration

## Integration posture

Isagi should integrate with existing harnesses rather than replacing them.

The baseline integration should be able to launch a harness in the right worktree and show it as an agent session. Deeper integration can be harness-specific:

- resume/session IDs
- waiting-for-user detection
- richer lifecycle events
- hooks or status signals

When a harness does not expose deeper metadata, Isagi should degrade gracefully instead of making the whole product depend on perfect integration.

## Non-goals for this document

This document does not define:

- exact package/module layout
- database schema
- IPC protocol
- process supervisor implementation
- terminal rendering library
- final harness adapter API

Those details should emerge through implementation while preserving the architecture boundary described here.
