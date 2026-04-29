# Task Detail Modal (MVP)

**Last updated:** 2026-04-28

## One-liner

The Task Detail modal answers: **"What do I need to know about this task, and how do I get into execution quickly?"**

## Primary job

- Act as the compact bridge from task artifact to execution session.
- Refresh enough task and milestone context that work can restart confidently.
- Support lightweight status/context changes without becoming a full workspace.

## Surface posture

- The modal is action-first and compact.
- It should help the user get in, act, and get back out quickly.
- It should show milestone context when present and useful, but not duplicate the full milestone artifact.

## Core principles

- The most relevant open session should be the easiest next action.
- Task metadata should stay lightweight.
- Notes and available milestone context support memory refresh, but remain secondary to execution.
- A done task should not invite more execution until its status changes.

## Key boundaries

- Project momentum and milestone browsing belong to `docs/product/screens/project-detail-screen.md`.
- Full execution belongs to `docs/product/screens/session-screen.md`.
- Task qualities belong to `docs/product/planning-artifacts.md`.

## Canonical references

- `docs/product/planning-artifacts.md`
- `docs/product/screens/project-detail-screen.md`
- `docs/product/screens/session-screen.md`
- `docs/product/mental-model.md`
