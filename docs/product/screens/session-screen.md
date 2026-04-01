# Session Screen (MVP)

**Last updated:** 2026-03-23

## One-liner

The Session screen answers: **"How do I stay in the conversation while keeping enough execution context visible to avoid mistakes?"**

## Primary job

- Act as the chat-first execution surface for one session.
- Keep the next conversational turn easy while still exposing runtime awareness.
- Provide the minimum supporting context needed for the current session type.

## Surface posture

- The Session screen is execution-first and conversation-dominant.
- The same shell supports task-backed, scratch, and shaping sessions.
- Supporting context should adapt to session type without changing the core posture of the page.

## Core principles

- The conversation is the dominant surface; supporting controls should stay quiet.
- Identity chrome should orient the user without pushing task or project summary blocks above the fold.
- Execution state should stay visible enough to prevent avoidable mistakes, but it should not overtake the conversation.
- Supporting context belongs beside the conversation rather than competing with it at the top of the page.
- Scratch sessions should stay lightweight and avoid invented task context.
- Shaping sessions should support proposal review and decision-making without collapsing into a project board.
- Session closure is a session action, distinct from task completion.
- Changing execution root creates a new session instead of preserving the same session identity.

## Key boundaries

- Deliberate backlog management belongs to `docs/product/screens/project-detail-screen.md`.
- Compact task jump-in belongs to `docs/product/screens/task-detail-modal.md`.
- Task semantics belong to `docs/product/task-model.md`.
- Deep runtime behavior belongs to `docs/architecture/execution-model.md` and `docs/product/config/project-task-git-rules.md`.

## Canonical references

- `docs/product/mental-model.md`
- `docs/product/task-model.md`
- `docs/architecture/execution-model.md`
- `docs/product/config/project-task-git-rules.md`
