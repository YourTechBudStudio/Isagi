# 0004-localized-action-feedback

status: accepted
date: 2026-06-14

## Decision

User-visible feedback for an action should appear at the interaction site that initiated or currently owns the action, unless that site is no longer available or the event is genuinely out-of-band.

An interaction site is the surface where the user is making the decision or waiting for the result: a command palette workflow, modal, inline form, recovery panel, row action, pane control, or another focused action surface. When that surface owns the action, expected validation failures, operational failures, cancellation states, and partial-success results should remain there instead of being displaced into unrelated chrome.

Toasts are reserved for feedback that is passive, backgrounded, cross-cutting, or no longer has a live action surface: background reconciliation, out-of-band runtime events, stale restoration warnings, passive recovery notices, or failures from work whose initiating surface has closed or cannot sensibly host the result.

External-system diagnostics may be shown at the action site when they help the user recover, especially Git, process, filesystem, or tool output. Those diagnostics are not product copy. The web app should still provide the primary user-facing headline/body in Isagi's voice, with raw external output clearly framed as diagnostic detail.

## Motivation

Isagi increasingly routes operational work through command-owned workflows: command palette actions, row affordances that dispatch commands, and future keyboard or chrome entry points. If the user starts an action in one surface but the result appears elsewhere, the feedback can feel detached from the decision that caused it.

This is especially costly for destructive or operational actions. A command may need to show a validation failure before running, a dirty-state confirmation, a partial-success result, or a raw Git diagnostic. Closing the action surface and emitting a toast makes those outcomes harder to connect to the user's last decision and often makes retry/cancel/close semantics less honest.

## Consequences

- Command-owned failures should usually stay inside the command surface that is currently open.
- Command-owned partial-success results should stay visible at the command surface instead of being treated as generic failures or background notifications.
- Toasts remain appropriate for background work, passive notices, recovery events, and failures whose original action surface is gone.
- Destructive and operational workflows need command/action-surface result states, not only success-close and thrown-error paths.
- Runtime and contracts should continue to expose stable codes, statuses, structured data, and diagnostics. The web app owns the primary copy and decides how to frame diagnostic detail.
- Raw Git/process/filesystem output may be displayed when useful, but it should be labeled or visually framed as diagnostic detail rather than used as the main user-facing message.

## Examples

- A command palette workflow that cannot delete a root worktree should show that expected failure in the palette workflow, not as an unrelated toast.
- A worktree delete that removes the checkout but fails to delete the branch should show a palette-local partial-success result with Git diagnostic detail.
- A background workspace reconciliation finding that a project disappeared may use a toast because there is no focused action surface waiting for the result.
- A row hover button may dispatch a command, but once the command palette owns the workflow, subsequent confirmations, failures, and partial results belong in the palette.

## Notes

This ADR defines a product-feedback ownership rule, not a requirement that every action use the command palette. Local inline actions can keep feedback inline. Modal workflows can keep feedback in the modal. The command palette is one important interaction site because Isagi models workbench actions as commands first, but the principle is broader: keep feedback where the user's action is being resolved.
