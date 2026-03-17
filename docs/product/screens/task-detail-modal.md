# Task Detail Modal (MVP)

**Last updated:** 2026-03-15

## One-liner

The Task Detail modal answers: **"What do I need to know about this task right now, and how do I jump into the right session fast?"**

## Primary job

- Act as a compact action modal for one task.
- Help the user start or resume work with minimal friction.
- Keep just enough task context visible to refresh memory on longer-running work.
- Allow quick inline task edits without turning the modal into a full task-management page.

## Non-goals

- Replacing Project Detail as the main backlog surface.
- Replacing the Session screen as the real execution surface.
- Becoming a full task page hidden inside a modal.
- Showing closed-session history or deep archival context in Phase 1.
- Introducing a standalone `Complete task` control distinct from status.

## Surface posture

- The task modal is a **compact action modal**, not a hidden full-page task workspace.
- The task modal is the modal exception to the shared contextual action-bar pattern used by the full Session and Project Detail pages.
- The surface is **action-first** and **session-aware**.
- Task-memory refresh is a secondary benefit, not the primary reason the modal exists.
- The modal should help the user get in, act, and get out quickly.

## Information hierarchy

### Header and inline metadata

- The top of the modal should establish the task clearly.
- The task title should stay visible and editable.
- Inline-editable task fields should include:
  - title
  - status
  - priority
  - due date
  - labels
  - collection

### Primary session action

- The primary CTA is about execution.
- If the task has an active open session, the primary CTA may read **Return to Active Session**.
- If the task has an open session and none are active, the primary CTA should be **Resume Session**.
- If the task has no open sessions, the primary CTA should be **Start session**.
- If multiple open sessions exist, the latest open session gets the primary treatment.
- This is UI prioritization only; it does not create a persistent model-level primary session.

### Open sessions only

- The modal should show only open or unclosed sessions in Phase 1.
- Open sessions should be ordered with the latest first.
- If more than one open session exists, additional sessions should appear as a compact secondary list below the primary session action.
- Closed-session history is intentionally omitted from the modal in MVP.

### Notes / description

- Notes are secondary to session actions and core task metadata.
- The description or notes area exists to refresh memory when the task is not fully fresh in mind.
- In MVP, the notes area stays visible and directly editable even when empty so the user always has a stable place to add context.

## Editing rules

- Core task metadata should be editable inline from the modal.
- Editing should stay lightweight and avoid mode-switching into a heavy form.
- Session actions should remain easy to reach even when metadata is editable.

## Done-task behavior

- A task in a `done`-bucket status should not emphasize **Start session** or **Resume session**.
- Reopening a task is handled by changing its status out of a `done` bucket.
- The act of reopening is intentionally lightweight; no separate reopen workflow is required.

## Relationship to Project Detail and Session

- Project Detail owns backlog scanning, saved views, and task selection.
- The Task Detail modal is the fast bridge from backlog item to execution.
- It relies on inline metadata editing and a primary session CTA rather than its own standalone action bar.
- The Session screen remains the primary place where actual agent work happens.
- Scratch sessions bypass the Task Detail modal because they are started outside task context and do not attach to tasks.
- Canonical parent-surface context lives in `docs/product/screens/project-detail-screen.md`.
- Canonical execution-surface context lives in `docs/product/screens/session-screen.md`.

## Out of scope / future phase notes

- Closed-session history inside the modal.
- Dependencies, subtasks, checklists, or richer workflow trees.
- A larger document-style task workspace.
- Separate task-completion controls distinct from status.
