# Task Detail Modal (MVP)

**Last updated:** 2026-03-23

## One-liner

The Task Detail modal answers: **"What do I need to know about this task right now, and how do I get into the right session quickly?"**

## Primary job

- Act as the compact bridge from backlog item to execution.
- Support lightweight inline edits to task metadata.
- Refresh enough task context that the user can restart work confidently.

## Surface posture

- The task modal is action-first.
- The task modal is compact by design, not a hidden full-page workspace.
- The modal should help the user get in, act, and get back out quickly.

## Core principles

- The most relevant open session should be the easiest next action.
- Task metadata should stay editable without turning the modal into a heavy form.
- The modal should show only the amount of context needed to restart work, not the full history of the task.
- Open-session awareness matters more here than archival session history.
- Notes support memory refresh, but they remain secondary to execution.
- A done task should not invite more execution until its status changes.

## Key boundaries

- Backlog browsing and organization belong to `docs/product/screens/project-detail-screen.md`.
- Full execution belongs to `docs/product/screens/session-screen.md`.
- Deeper task semantics belong to `docs/product/task-model.md`.

## Canonical references

- `docs/product/task-model.md`
- `docs/product/screens/project-detail-screen.md`
- `docs/product/screens/session-screen.md`
- `docs/product/mental-model.md`
