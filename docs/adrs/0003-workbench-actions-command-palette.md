# 0003-workbench-actions-command-palette

status: accepted
date: 2026-06-12

## Decision

Workbench-level frontend actions should be modeled as command palette commands first. Mouse, keyboard, rail, pane, and other chrome affordances should invoke those commands instead of each surface reimplementing its own action workflow.

A command owns the frontend action orchestration for its product intent: resolving the active target, collecting arguments, showing confirmation, calling runtime mutations, handling warnings/errors, invalidating server-state queries, and preserving or updating frontend selection where appropriate.

UI affordances may still provide local entry points, but they should be thin triggers:

- a rail context-menu item can select the clicked surface, then open `Rename active surface` or `Delete active surface`
- a pane delete button can focus the pane, then open/run `Delete active pane`
- a keyboard shortcut can dispatch the same active-pane command
- command palette entries remain directly available for keyboard-first users

Commands should target explicit runtime identifiers once invoked. They must not ask the runtime to infer operational targets from persisted active context. Frontend active selection may be used only to choose the intended command target before calling the runtime API.

This ADR applies to workbench/product actions, not every UI event. Local component state, form typing, transient hover/focus behavior, and tiny presentational toggles do not need command palette entries unless they represent a reusable workbench action.

## Motivation

Isagi has several equivalent ways to perform the same workbench action: command palette, keyboard shortcuts, rail chrome, pane controls, and future context menus. If each path implements its own confirmation, mutation, copy, cache refresh, and warning behavior, destructive and operational actions will drift.

Centralizing these actions through commands gives each product intent one frontend workflow while preserving multiple input methods. It also keeps keyboard access first-class: adding a mouse affordance should not create an action that keyboard users cannot reach.

## Consequences

- New workbench actions should usually start as command definitions, even when the first visible entry point is a button or context menu.
- UI controls that trigger workbench actions should select/focus their intended target if needed, then dispatch/open the command.
- Confirmation and argument collection should live in the command workflow or command-owned UI, not separately in every caller.
- Runtime mutations remain explicit and target ID based; commands are a frontend orchestration layer, not a runtime source of truth.
- Shared copy for command-owned confirmations, warnings, and errors belongs in the web copy layer.
- Commands may be hidden from the palette when unavailable, but still reused by shortcuts or local affordances when they can establish the same target.

## Notes

For the PTY pane/surface close-delete slice, this means:

- `Rename active surface` owns the rename text argument and title mutation.
- `Delete active surface` runs immediately, including for live sessions, and owns surface deletion, cleanup warnings, and cache refresh.
- `Delete active pane` runs immediately, including for live sessions, and owns pane deletion, last-pane surface deletion behavior, cleanup warnings, and cache refresh.
- Rail surface context-menu items invoke the active-surface commands after selecting the clicked surface.
- Pane trash controls and `Cmd+W` invoke the active-pane command after focusing the intended pane.
