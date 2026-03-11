# Session Screen (MVP)

**Last updated:** 2026-03-10

## One-liner

The Session screen answers: **"What is the agent doing for this task right now, and what can I do next without losing execution context?"**

## Primary job

- Act as the execution surface for one task-linked agent session.
- Keep the current task, execution root, and session state visible while work is in progress.
- Let the user continue work, steer execution, and update task state without leaving the session unnecessarily.
- Reuse the same contextual action-bar pattern as other task-facing surfaces so common actions feel consistent.

## Non-goals

- Replacing Project Detail as the deliberate backlog-management surface.
- Becoming a portfolio or project analytics view.
- Introducing a standalone `Complete task` action distinct from status.
- Automating merge, cleanup, or PR lifecycle work as a side effect of task completion.

## Page posture

- A session is always tied to a task, including planning-oriented sessions that use a dedicated planning task.
- The Session screen is execution-first and conversation-centric.
- Task identity stays stable even when the execution root changes.
- Session UI should expose useful context without turning the page into a second backlog board.

## Information hierarchy

### Contextual action bar

- The top action bar should keep the current task context, execution context, and common task/session actions visible.
- This is the canonical explanation of the shared contextual action-bar pattern also reused by Project Detail.

### Conversation surface

- The conversation is the dominant surface of the page.
- Session history, current turn, and agent progress stay central.

### Contextual side visibility

- Supporting read-only context may live in a right-side panel or equivalent secondary surface.
- Useful examples include overlapping sessions, last known execution root, related task metadata, or other task/session visibility that helps the user avoid mistakes.

## Shared contextual action bar

- The contextual action bar is a shared surface pattern across session, task, and project-detail views.
- The shared pattern should keep placement, density, and interaction posture familiar even when each page exposes different actions.
- On the Session screen, that bar should emphasize task-linked and execution-aware actions such as:
  - current task/breadcrumb context
  - branch or execution-root visibility
  - execution-root switching or managed-worktree actions
  - environment shortcuts such as editor or terminal actions
  - task-status updates
  - contextual panel toggles
- Session actions may update task status, but the MVP does not add a separate `Complete task` action. Moving the task into a `done`-bucket status is how the product treats it as complete/closed.

## Relationship to task status

- Sessions remain attached to their parent task across resumptions until manually closed or the task enters a terminal `done`-bucket status.
- Status updates may happen from the session surface when the user wants to advance or close the task.
- Review, follow-up, and handoff work remain on the same task rather than spawning subtasks.

## Right-side contextual visibility

- Secondary context should help the user understand what else is active around the current session without competing with the conversation itself.
- This area is appropriate for read-only visibility such as collision warnings, related sessions, execution-root history, or lightweight task metadata.

## Out of scope / future phase notes

- Separate completion controls distinct from task status.
- Automatic merge or worktree cleanup on task closure.
- Rich backlog-planning controls that belong on Project Detail.
- Full in-app PR, merge, or release orchestration.
