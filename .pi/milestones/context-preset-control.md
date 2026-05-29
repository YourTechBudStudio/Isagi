---
title: Context and Preset Control
status: candidate
created: 2026-05-28
updated: 2026-05-28
tags: [candidate, presets, mcp, tools, context]
---

# Summary

Let Isagi launch agent sessions with intentional context: harness choice, flags, environment, MCP servers, skills, tool sets, and workflow-specific presets.

# Why this matters

Current terminal harnesses either expose too much capability all the time or require manual setup. The user wants different agent modes for different kinds of work: discovery, orchestration, frontend implementation, research, content, and basic coding.

The value is context hygiene: tools and capabilities should be present when useful and absent when they would pollute the workspace.

# Direction

Explore first-class agent presets and conditional tool/context loading.

Possible preset dimensions:

- harness: Pi, OpenCode, Claude Code, Codex, etc.
- launch command and flags
- cwd/worktree behavior
- environment variables
- MCP/tool server configuration
- skills or prompt/context bundles
- whether the agent may spawn child agents
- whether the agent may access Sparks/project-discovery tools

# Done condition

Not hardened yet.

A future milestone may be ready when we know:

- which preset features are needed for daily use
- which config belongs globally vs per project
- how much can be controlled through harness launch flags/config files
- whether runtime tool loading is necessary or launch-time presets are enough

# Boundaries

Do not make this block Worktree Continuity.

For the MVP, agent presets can stay minimal: enough to launch the desired harness in the correct worktree. Deep MCP/tool/context control can come later.

# Continue with

After the first agent-session slice exists, run discovery on:

1. Minimal useful preset schema.
2. Global vs project preset hierarchy.
3. Harness-specific adapter needs.
4. How an Isagi configuration skill could help users create/edit presets without forms.
5. Whether conditional tool loading should happen at launch time, runtime, or both.

# Notes

This candidate connects to the future agent-assisted configuration flow. It should preserve the principle that users should not need to manage tedious settings UIs or hand-edit complex files for common setup.
