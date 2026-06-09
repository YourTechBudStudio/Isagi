# Product Model

## Overview

Isagi is organized around projects, worktrees, and the environments associated with those worktrees.

The main idea is simple: a worktree should not be treated as only a path on disk. It is the user-facing continuity unit. Isagi associates one hidden worktree environment with each worktree: agent sessions, commands, surfaces, layout, restoration data, and attention state.

## Core primitives

### Global/user config

User-level configuration shared across projects.

Examples:

- known harnesses
- global agent presets
- user preferences
- default shell/runtime behavior
- reusable configuration patterns

### Project

A registered repository-level container.

A project owns project-specific defaults such as commands, worktree initialization behavior, preferred harness presets, and default surfaces.

### Worktree

The primary continuity unit in Isagi.

A worktree represents a concrete place where work happens. It is backed by a branch and a checkout. The main/root checkout is treated as a first-class worktree for product purposes, even though Git distinguishes it from additional worktrees.

A worktree may have an associated environment with:

- agent surfaces containing agent session panes
- terminal, browser, editor, and artifact surfaces
- command processes
- remembered layout state
- attention state
- parked state

### Worktree environment

The hidden remembered runtime and UI state associated one-to-one with a worktree.

A worktree environment is what makes a worktree feel resumable rather than like a plain folder. It can include active or restorable agent sessions, commands, surfaces, panels, windows, layout, attention, and restoration metadata.

Users navigate worktrees and surfaces; they generally should not need to see or manage an "environment" object directly.

### Command

A terminal command that can be run inside a worktree environment.

Commands are not rail surfaces by default. They are worktree-scoped runtime processes shown through status and command-monitor UI such as the command drawer. A command may exit quickly, run for a long time, print logs, bind a port, or fail.

Isagi should not require rigid command types such as `devServer`, `testWatcher`, or `database`. A command is just a command.

### Surface / panel

A visible work surface attached to a worktree environment and shown under a worktree in navigation.

Initial/foundation surface kinds:

- agent surface - a visible agent work surface; it contains one or more agent session panes
- terminal surface - an interactive shell/PTY surface
- browser surface - a preview or browser context
- editor surface - an editor/code-server context
- artifact surface - files, Markdown, diffs, review artifacts, or similar user-visible outputs

Commands are not surfaces by default, though a command may produce a URL or artifact that opens a surface.

A panel may live inside the main window or in a secondary work surface.

### Attention signal

A status that tells the user something needs attention.

The most important attention signal is an agent session waiting for human input. Worktrees can also aggregate attention from the agent sessions, commands, or processes inside their associated environment.

## Relationship model

The conceptual hierarchy is:

```txt
Global/user config
  -> Projects
    -> Worktrees
      <-> Worktree environments
            -> Surfaces/panels
                 -> Agent surfaces
                      -> Agent sessions/panes
                 -> Terminal/browser/editor/artifact surfaces
            -> Commands/processes
            -> Layout/restoration state
            -> Attention signals
```

This is a product model, not a required database schema. User-facing navigation is simpler: project -> worktree -> surface.

## Naming rules

- Prefer **worktree** as the primary user-facing noun.
- Use **worktree environment** for the hidden resumable state associated with one worktree.
- Do not use **Isagi session** as a product noun. Older planning notes that use it for navigation should be read as **worktree** unless they explicitly mean an agent harness process.
- Use **agent session** for first-class coding-agent harness processes.
- Use **agent surface** for a visible surface that contains one or more agent sessions/panes.
- Use **command** for project-defined terminal commands/processes.
- Use **surface** or **panel** for visible UI containers.
- Avoid using **task** as a core Isagi primitive. A task may exist in the user's head or planning system, but Isagi's durable product model revolves around worktrees.
- Use **checkout** mostly as a verb or Git action, not as a parallel product noun.

## Root/main worktree behavior

The main/root checkout should appear as a first-class worktree in Isagi.

It is special only because it is the root checkout and should not be closed or deleted from Isagi like an additional worktree might be. Otherwise, it should participate in the same environment model.

## Worktree continuity behavior

### Existing worktree

When the user switches into an existing worktree, Isagi should restore that worktree's previous environment state where possible.

That may include:

- last active agent session
- command state or restorable commands
- browser/editor/artifact panels
- layout
- secondary work surface state
- attention signal

### New worktree

When the user creates a new worktree, Isagi creates or reuses a branch and creates a separate worktree checkout for it.

If the named branch does not exist, Isagi should create it. If the branch already has an existing worktree, Isagi should switch to that worktree rather than creating a duplicate. Isagi should not allow two worktrees in one project to represent the same checked-out branch.

After creation, Isagi should initialize the associated worktree environment from project-level defaults or an equivalent template concept.

A new worktree does not need to inherit the currently active worktree's exact layout by default. The project should define the default room shape.

### Parked worktrees

A worktree may be marked parked when it has not been touched for a long threshold, such as eight hours. Parked means visually quieter, not less truthful: attention and error states should still bubble from the worktree environment.

### Missing artifacts

If a restored file or artifact path does not exist in the active worktree, Isagi should show a missing state rather than silently closing the panel.
