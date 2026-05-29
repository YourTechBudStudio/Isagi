# Product Foundation

## What eSiggy is

eSiggy is a desktop workbench for agent-driven development where worktrees become resumable work environments.

It does not replace existing terminal coding agents. It wraps around them, launches them in the right context, and keeps the surrounding work surface attached to the worktree the user is working in.

## Core value proposition

eSiggy preserves momentum by making the environment around a worktree move with it:

- agent sessions
- project commands
- command logs
- browser previews
- code review surfaces
- file and Markdown artifacts
- panel/window layout
- attention state

The user should be able to switch worktrees without manually rebuilding their terminal, browser, editor, logs, and review context every time.

## Core problem

Worktrees are powerful, but most tools treat them as folders. The real work environment lives outside the folder: terminals, agents, dev servers, browser tabs, editor windows, artifacts, and human-attention cues.

That means switching worktrees is not just changing directories. It often means reconstructing the entire supporting workspace by hand.

## Product promise

Each worktree should feel like a room the user can leave and return to.

When the user returns, eSiggy should restore as much of the room as it reasonably can: the active agent, running or restorable commands, supporting surfaces, layout, and signals about what needs attention.

## What eSiggy is not

- Not a replacement for Pi, OpenCode, Claude Code, Codex, or other harnesses.
- Not a full IDE from day one.
- Not a generic terminal multiplexer.
- Not task management first.
- Not a generic agent platform before the core continuity loop works.
- Not responsible for magically fixing project-level resource conflicts such as fixed ports or global files.

## Durable product principles

### Worktrees are first-class

The worktree is the primary continuity unit. Projects contain worktrees, and each worktree can have its own environment.

### Tasks stay user-owned

A task may be the user's intent, but eSiggy does not need to model tasks as a first-class primitive at the product foundation level. The concrete thing eSiggy can reliably manage is the worktree environment.

### Existing harnesses remain useful

eSiggy should orchestrate around existing agent harnesses instead of replacing them. It should launch them, frame them, and restore their surrounding environment where possible.

### Start conservative, then let power users make rooms feel alive

The safe default should avoid surprising resource usage or conflicts. Users and projects can opt into more persistent behavior when they know a command or surface is safe to keep alive.

### The work surface is the hero

Navigation, configuration, and chrome exist to support the active work. The agent terminal, browser/code surfaces, and artifacts should remain the focus.

### Attention state is part of momentum

The user needs to know which agent or worktree needs them. Waiting-for-user state is not just a notification; it is part of keeping work moving.

### Configuration should not become toil

Users should not need to hand-edit complex files or fill out tedious settings forms for common setup. eSiggy should make configuration inspectable and automatable, with an eventual path toward agent-assisted configuration.

## Future-facing directions

eSiggy's foundation leaves room for deeper agent orchestration and richer context control later:

- visible long-lived child agents
- workflow-specific agent presets
- conditional tool and MCP exposure
- richer harness-specific session metadata
- remote execution through the server/runtime architecture

These directions should build on the core continuity model rather than distract from it.
