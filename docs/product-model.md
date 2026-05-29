# Product Model

## Overview

Isagi is organized around projects, worktrees, and the environments attached to those worktrees.

The main idea is simple: a worktree should not be treated as only a path on disk. It should have an environment around it: agent sessions, commands, surfaces, layout, and attention state.

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

A worktree represents a concrete place where work happens. The main/root checkout is treated as a first-class worktree for product purposes, even though Git distinguishes it from additional worktrees.

A worktree may have:

- one or more agent sessions
- command processes
- browser/code/artifact surfaces
- remembered layout state
- attention state

### Environment

The remembered runtime and UI state attached to a worktree.

An environment is what makes a worktree feel resumable rather than like a plain folder. It can include active or restorable sessions, commands, panels, windows, and status.

### Command

A terminal command that can be run inside a worktree environment.

Isagi should not require rigid command types such as `devServer`, `testWatcher`, or `database`. A command is just a command. It may exit quickly, run for a long time, print logs, bind a port, or fail.

### Surface / panel

A visible work surface attached to an environment.

Examples:

- agent terminal
- command logs
- browser preview
- code review surface
- file viewer
- Markdown artifact viewer
- secondary-window tab

A panel may live inside the main window or in a secondary work surface.

### Attention signal

A status that tells the user something needs attention.

The most important attention signal is an agent session waiting for human input. Worktrees can also aggregate attention from the sessions or processes inside them.

## Relationship model

The conceptual hierarchy is:

```txt
Global/user config
  -> Projects
    -> Worktrees
      -> Environments
        -> Agent sessions
        -> Commands/processes
        -> Surfaces/panels
        -> Attention signals
```

This is a product model, not a required database schema.

## Naming rules

- Prefer **worktree** as the primary noun.
- Use **environment** for the resumable state around a worktree.
- Use **command** for project-defined terminal commands.
- Use **agent session** for first-class coding-agent processes.
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
- browser/code/artifact panels
- layout
- secondary work surface state
- attention signal

### New worktree

When the user creates a new worktree, Isagi should initialize it from project-level defaults or an equivalent template concept.

A new worktree does not need to inherit the currently active worktree's exact layout by default. The project should define the default room shape.

### Missing artifacts

If a restored file or artifact path does not exist in the active worktree, Isagi should show a missing state rather than silently closing the panel.
