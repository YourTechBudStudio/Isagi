# Session Screen (MVP)

**Last updated:** 2026-03-12

## One-liner

The Session screen answers: **"How do I keep talking to this agent session while staying aware of the execution context that could bite me?"**

## Primary job

- Act as the chat-first execution surface for one agent session, whether that session is task-backed or scratch.
- Keep the conversation dominant so the user can type the next message immediately.
- Keep execution state visible without crowding the conversation canvas.
- Provide lightweight access to task context, task status, and session utilities when the session is task-backed, without turning the page into a second backlog surface.
- Reuse the same floating contextual action-bar pattern as Project Detail so the main work surfaces feel consistent.

## Non-goals

- Replacing Project Detail as the deliberate backlog-management surface.
- Replacing the Task Detail modal as the fast task-inspection bridge from board to execution.
- Introducing a standalone `Complete task` action distinct from status.
- Turning the page into a planning dashboard, analytics surface, or backlog board.
- Keeping rich git controls permanently expanded in a way that competes with the chat.

## Surface posture

- The Session screen has two MVP variants that share the same shell:
  - task sessions for tracked accountable work
  - scratch sessions for project-scoped exploration without a task
- Planning-oriented sessions remain task-backed by using a dedicated planning task.
- The Session screen is chat-first and execution-aware.
- The visible session title is independent from the task title and is generated for the session itself.
- The top identity area should stay extremely minimal.
- There should be no large resumability or task-summary block above the fold.
- When a session is task-backed, task identity remains stable even when execution root changes through rebind behavior.

## Information hierarchy

### Minimal identity header

- The page may show a small session title as quiet identity chrome.
- This area should not become a task-metadata header.
- Project name, task metadata, and other supporting context belong in the right panel rather than the main canvas chrome.

### Floating contextual action bar

- The Session screen keeps a floating contextual action bar separate from the minimal identity header.
- This bar is the shared full-page action pattern also used by Project Detail.
- On Session, the bar should prioritize session utilities and deeper execution actions rather than task-summary content.

### Conversation canvas

- The conversation is the dominant surface of the page.
- The user should land directly in the conversation with the composer ready for the next turn.
- No large checkpoint, resumability summary, or task brief should compete with the latest conversation turns by default.

### Bottom execution rail

- Live execution state should stay visible near the composer, where the user is actively working.
- This rail shows current runtime state rather than becoming the place for every deeper git action.

### Right context panel

- A right-side context panel opens by default.
- Its open/closed state should be remembered per session.
- Task sessions use this panel for task context and nearby session visibility that support the current conversation.
- Scratch sessions should not invent fake task context.
- For scratch sessions, the right panel should be omitted rather than showing empty or placeholder task UI.
- Scratch sessions therefore do not expose a right-panel toggle because there is no panel to reveal.

## Action-bar actions

- The Session action bar should cover:
  - collapse sidebar
  - open terminal
  - open VS Code
  - reveal richer git controls such as execution-root switching, git-mode choice, and related managed-worktree or rebind actions
  - close session
  - toggle right panel for task-backed sessions only
- `Close session` is a true session-level action and is a better fit here than `Complete task`.
- `Close session` should ask for confirmation only when the agent is currently running.
- The action bar may expose git and workspace actions, but it should avoid turning into a dense always-expanded control deck.
- Scratch sessions should omit the right-panel toggle entirely.

## Execution rail contents

- The bottom execution rail should stay always visible near the composer.
- It should show the current execution state at a glance:
  - branch
  - repo-root versus managed-worktree mode
  - dirty or uncommitted-change indicator
  - collision chip when relevant
- The rail should emphasize current state and warnings, while richer git actions stay discoverable from the action bar.
- This keeps live runtime visibility near the composer and reserves the action bar for deeper execution changes.

## Right-panel contents

- For task sessions, the right panel should lead with task metadata first.
- Recommended section order for task sessions:
  1. task metadata
  2. notes / description / context
  3. active sibling sessions on the same task
  4. optional execution details
- Task metadata here may include the task title, status, priority, due date, labels, and collection when present.
- The task status control should live in this panel rather than in the action bar or execution rail.
- Notes remain supportive context rather than the main surface of the page.
- Sibling-session visibility should stay limited to active sibling sessions in Phase 1.
- Scratch sessions do not have a task side panel, do not expose task-status controls, and should keep the conversation shell clean rather than substituting project-context filler.

## Task status and session closure rules

- The MVP does not add a standalone `Complete task` control on the Session screen.
- Task completion remains status-driven.
- Moving the task into a `done`-bucket status is what closes the task in MVP.
- Task status changes may happen from the Session screen, but they should happen through the right-panel status control.
- Session closure is a separate session-level action and should not be conflated with task completion.

Canonical task and runtime semantics live in:

- `docs/product/task-model.md`
- `docs/architecture/execution-model.md`

## Collision and sibling-session visibility

- Collision warnings are advisory rather than blocking.
- The Session screen should surface collision awareness as:
  - a chip in the execution rail when relevant
  - an expanded warning treatment when the collision is active enough to deserve more attention
- The right panel may also show related context such as active sibling sessions or execution details that help the user self-correct.
- Sibling-session visibility here is for awareness, not for redefining a primary session model.

## Relationship to Home, Project Detail, and Task Detail

- Home is the minimal re-entry surface that gets the user back into a session quickly.
- Project Detail is the deliberate project-scoped backlog surface.
- The Task Detail modal is the compact bridge from a task on the board into execution.
- The Session screen is where the actual agent work happens, whether the session is task-backed or scratch.
- Project Detail and Session share the floating contextual action-bar pattern, while the Task Detail modal remains the lighter modal exception.
- Scratch sessions bypass the Task Detail modal because they are not task-backed.

Related docs:

- `docs/product/screens/home-screen.md`
- `docs/product/screens/project-detail-screen.md`
- `docs/product/screens/task-detail-modal.md`
- `docs/journeys/coding-workflow.md`

## Out of scope / future phase notes

- Separate completion controls distinct from task status.
- Full in-app PR, merge, or release orchestration.
- Automatic merge or worktree cleanup on task closure.
- Rich backlog-planning controls that belong on Project Detail.
- Closed-session history as a major panel section.
