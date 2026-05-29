# Configuration Model

## Purpose

Configuration in eSiggy exists to make worktree environments easy to recreate.

It should capture useful defaults without turning setup into toil. Users should not need to fill out tedious forms or hand-edit complex files for common workflows.

This document describes configuration concepts, not a final schema.

## Config layers

### Global/user config

Configuration shared across projects.

Examples:

- known agent harnesses
- global agent presets
- user preferences
- default shell/runtime behavior
- reusable command or surface patterns
- future tool/MCP preset defaults

### Project config

Configuration tied to a specific repository/project.

Examples:

- named project commands
- default agent preset
- default worktree initialization template
- default surfaces
- command persistence preferences
- command visibility or agent-runnability rules

### Worktree environment state

Remembered state for a specific worktree.

Examples:

- last active agent session
- sessions associated with the worktree
- command processes or restorable command intent
- open browser/code/artifact surfaces
- main/secondary window layout
- attention state

Worktree environment state is partly durable and partly runtime-derived. eSiggy should preserve what helps restoration while rediscovering Git and filesystem facts where possible.

## Commands

Commands are terminal commands.

eSiggy should not require users to classify commands as dev servers, test watchers, databases, or short-running scripts. A command can exit quickly, run indefinitely, bind a port, produce logs, or fail.

Configuration can describe how eSiggy should treat the command, but the base noun stays simple.

Possible command-level concepts:

- name
- shell command
- persistence behavior
- browser/open-surface preference
- agent-runnable vs human-only intent

These are conceptual dimensions, not a committed schema.

## Command persistence

Commands should be non-persistent by default.

A non-persistent command is safe and conservative: eSiggy can stop or recreate it as the active worktree changes.

A persistent command is explicit. It tells eSiggy the user/project expects that command to keep running across worktree switches where possible.

This principle matters:

> eSiggy starts conservative, but lets power users make environments feel alive.

If a command is marked persistent but fails because of fixed ports, global files, or other shared resources, eSiggy should surface the failure. It should not try to magically fix project-level configuration.

## Worktree initialization templates

A worktree initialization template describes the default room shape for a new worktree in a project.

It may include:

- commands to start
- agent sessions or presets to open
- browser/code/artifact surfaces to create
- default layout
- other environment setup behavior

Commands define reusable actions. Templates decide which actions happen when a worktree environment is initialized.

## Agent presets

Agent sessions are first-class in eSiggy, even if they share process/PTY machinery internally with commands.

Agent presets describe how to launch a harness in a useful mode.

Possible preset dimensions:

- harness type
- launch command and flags
- working-directory behavior
- environment variables
- session/resume behavior where supported
- future tool, MCP, or skill context

Deep context control can evolve over time. The foundational requirement is that eSiggy can launch the right harness in the right worktree and attach the resulting session to that worktree's environment.

## Agent-assisted configuration

A future-friendly configuration model should allow eSiggy to be configured through an agent or skill.

The user should be able to ask for configuration changes in normal language, review the proposed changes, and let the agent update the relevant project or user config.

This keeps configuration aligned with how eSiggy is used: as an agent-centered workbench rather than a form-heavy settings app.

## Schema stability

The configuration model should stay conceptually stable while the concrete schema evolves.

Prefer documenting durable concepts:

- what layer owns a setting
- what behavior the setting enables
- what source of truth should be trusted
- what should degrade gracefully

Avoid committing global docs to low-level schema details before the product proves them.
