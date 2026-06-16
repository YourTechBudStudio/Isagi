# 0006-durable-worktree-environment-entities

status: accepted
date: 2026-06-15

## Decision

Worktree environments own durable, restorable entities that are attached to surfaces and panes. These entities preserve the user's room across runtime restarts and, where possible, machine restarts.

Agent sessions are the first concrete durable entity in this model. Future terminal sessions, browser surfaces, editor contexts, artifact surfaces, commands, and other worktree-environment entities may follow the same layering when they need restoration behavior.

A durable entity may have an active PTY process, browser process, editor process, command process, or other process incarnation. That active process is replaceable. The durable entity is the continuity unit.

## Motivation

The product model says a worktree should feel like a resumable room, not a plain folder. That room contains surfaces, panes, agent sessions, terminals, commands, artifacts, attention, and restoration metadata. Process state alone cannot provide that continuity because processes can disappear when the runtime restarts, the machine restarts, a backend degrades, or an external tool exits.

Putting durable restoration identity above process incarnations lets Isagi recreate the environment honestly. The UI can keep the pane visible, the runtime can decide whether and how to recreate the active process, and failures can be shown as recoverable states instead of silently deleting the user's context.

## Consequences

- Durable entity records belong to the runtime-owned worktree environment state.
- Surfaces and panes attach to durable entities, not directly to process records, whenever the user-facing concept is meant to survive process loss.
- An agent session persists independently of its active PTY process.
- A durable entity may point to its current active process incarnation when one exists.
- Opening or attaching to a durable entity may lazily create a new process incarnation if the previous one is missing or dead.
- Restoration failure leaves the durable entity visible with a recoverable state and diagnostics.
- Future terminal, browser, editor, artifact, or command restoration should use this layer rather than overloading PTY or process records.
- Worktree-environment restoration should remain explicit operational work owned by the runtime. The frontend may request restoration by opening or attaching to a pane, but it must not infer operational state from persisted active context.

## Notes

This ADR does not require every surface or pane to have complex restoration behavior immediately. It defines the layering for entities that need it. A simple terminal session may initially recreate a fresh shell when opened after process loss, while an agent session may resume through harness-specific session identity.
