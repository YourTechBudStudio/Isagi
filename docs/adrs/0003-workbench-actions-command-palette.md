# 0003-workbench-actions-command-palette

status: accepted
date: 2026-06-12
amended: 2026-11-22 (one keymap owns app shortcuts)

## Decision

Workbench-level frontend actions should be modeled as command palette commands first. Mouse, keyboard, rail, pane, and other chrome affordances should invoke those commands instead of each surface reimplementing its own action workflow.

A command owns the frontend action orchestration for its product intent: resolving the active target, collecting arguments, showing confirmation, calling runtime mutations, handling warnings/errors, invalidating server-state queries, and preserving or updating frontend selection where appropriate.

UI affordances may still provide local entry points, but they should be thin triggers:

- a rail context-menu item can select the clicked surface, then open `Rename active surface` or `Delete active surface`
- a pane delete button can focus the pane, then open/run `Delete active pane`
- a keyboard shortcut can dispatch the same active-pane command
- command palette entries remain directly available for keyboard-first users

Commands should target explicit runtime identifiers once invoked. They must not ask the runtime to infer operational targets from persisted active context. Frontend active selection may be used only to choose the intended command target before calling the runtime API.

App keyboard shortcuts have one owner: the keymap in `apps/web/src/lib/shortcuts`. Each entry maps a chord (`Mod+K`, where `Mod` is Cmd on macOS and Ctrl elsewhere) to a command id, and the component that owns the command binds it; no component adds its own `keydown` listener for an app shortcut. Each entry also declares whether it takes priority over focused surfaces. A priority entry is handled in the window's capture phase and stopped, so no terminal, editor or text input sees the key. Every other entry yields: it is handled only when the focused surface leaves the key alone (bubble phase), or, in the capture phase, only when its own guards say the key is not the surface's (Mod+W skips editable targets). Only the command palette shortcut takes priority today. It is how a user gets anywhere from anywhere, and every other app chord either belongs to shells and editors too (^N, ^W) or acts destructively on a pane that may hold a live session (Mod+W).

Same-origin embedded documents, such as the Code Server editor frame, feed the same keymap: the pane attaches each loaded document as a shortcut source. A source dispatches priority entries only, and only for trusted (user-generated) key events, so a script inside the embedded document can neither trigger an app command nor reach the yielding shortcuts.

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
- A new app shortcut is a keymap entry, not a listener. It yields unless there is a reason for it to beat every focused surface; giving an entry priority takes its chord away from shells, the editor and text fields.
- The palette's priority has a cost users can see. In the editor pane, Ctrl+K (Cmd+K on macOS) no longer starts VS Code's chord shortcuts (Ctrl+K Ctrl+S, Ctrl+K Ctrl+C and the rest); users can remap those inside Code Server. In terminal and agent panes, the shell never receives ^K, readline's kill-line.
- Chords match their modifiers exactly, so the palette's `Mod+K` does not take `Mod+Shift+K` (VS Code's delete line) or `Mod+Alt+K`.
- Embedded documents nested inside the editor frame, such as Code Server webviews (markdown preview, extension panels), are not shortcut sources, and some are cross-origin; Mod+K does not reach the app while focus is inside one.

## Notes

For the PTY pane/surface close-delete slice, this means:

- `Rename active surface` owns the rename text argument and title mutation.
- `Delete active surface` runs immediately, including for live sessions, and owns surface deletion, cleanup warnings, and cache refresh.
- `Delete active pane` runs immediately, including for live sessions, and owns pane deletion, last-pane surface deletion behavior, cleanup warnings, and cache refresh.
- Rail surface context-menu items invoke the active-surface commands after selecting the clicked surface.
- Pane trash controls and `Cmd+W` invoke the active-pane command after focusing the intended pane.

For app shortcuts (amended 2026-11-22), the keymap is `Mod+K` toggle palette (capture, priority), `Mod+N` Add project (bubble), `Mod+.` toggle zen (bubble) and `Mod+W` delete active pane (capture, yielding to editable targets and already-claimed keys). Escape-to-dismiss handlers and terminal copy/paste keys belong to their components and are not app shortcuts.
