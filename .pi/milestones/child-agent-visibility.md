---
title: Child Agent Visibility
status: candidate
created: 2026-05-28
updated: 2026-05-28
tags: [candidate, agents, orchestration, visibility]
---

# Summary

Make long-lived child agents visible, inspectable, and manageable inside Isagi instead of hiding them behind terminal-agent internals.

# Why this matters

Some workflows are not a single agent with quick throwaway sub-agent calls. They involve persistent child agents doing meaningful parallel work. Current terminal harnesses make those flows hard to observe and manage.

The value is not merely spawning agents. The value is knowing what child agents exist, what they are doing, when they need attention, and how they relate to the parent workflow.

# Direction

Explore a model where a parent agent/session can spawn or register child agent sessions, and Isagi can show those child sessions as visible process-backed panels or rows.

Possible capabilities:

- parent/child session tree
- child agent lifecycle state
- output streaming
- open child agent as side panel or secondary surface
- attention/status aggregation
- eventual parent-child communication visibility

# Done condition

Not hardened yet.

A future milestone may be ready when we know:

- how child agents are spawned or registered
- which harnesses can expose the needed lifecycle information
- what minimal visibility would make multi-agent workflows meaningfully easier
- whether this belongs after Worktree Continuity or after preset/context control

# Boundaries

Keep this parked until Worktree Continuity proves the basic worktree/session/surface model.

Avoid turning this into a generic distributed agent platform too early.

# Continue with

After Worktree Continuity is dogfoodable, run discovery on:

1. What counts as a child agent vs a command vs a separate first-class session.
2. How parent agents should request/spawn/register child agents.
3. What visibility is useful without overwhelming the main work surface.
4. Whether child-agent panels should live in the main window, secondary window, or a dedicated orchestration view.

# Notes

This candidate depends heavily on the process/session substrate created by Worktree Continuity.
