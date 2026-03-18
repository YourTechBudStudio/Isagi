# Session Screen (MVP)

**Last updated:** 2026-03-17

## One-liner

The Session screen answers: **"How do I keep talking to this agent session while staying aware of the execution context that could bite me?"**

## Primary job

- Act as the chat-first execution surface for one agent session, whether that session is task-backed, scratch, or shaping.
- Keep the conversation dominant so the user can type the next message immediately.
- Keep execution state visible without crowding the conversation canvas.
- Provide lightweight access to the right supporting context for the current session kind without turning the page into a second backlog surface.
- Reuse the same floating contextual action-bar pattern as Project Detail so the main work surfaces feel consistent.

## Non-goals

- Replacing Project Detail as the deliberate backlog-management surface.
- Replacing the Task Detail modal as the fast task-inspection bridge from board to execution.
- Introducing a standalone `Complete task` action distinct from status.
- Turning the page into a planning dashboard, analytics surface, or backlog board.
- Keeping rich git controls permanently expanded in a way that competes with the chat.

## Surface posture

- The Session screen has three MVP variants that share the same shell:
  - task-backed sessions for tracked accountable work
  - scratch sessions for project-scoped exploration without a task
  - shaping sessions for tracked project-scoped backlog-shaping work without a task
- The Session screen is chat-first and execution-aware across all three variants.
- The visible session title is independent from any task title and is generated for the session itself.
- Shaping sessions may use a simple project-based default title.
- The top identity area should stay extremely minimal.
- There should be no large resumability or task-summary block above the fold.
- When a session is task-backed, task identity remains stable even when execution root changes through rebind behavior.

## Information hierarchy

### Minimal identity header

- The page may show a small session title as quiet identity chrome.
- This area should not become a task-metadata header.
- Scratch sessions and shaping sessions should carry a small visible mode badge in this identity chrome.
- Normal task-backed sessions do not require a special badge.
- Project name, task metadata, and other supporting context belong in the right panel rather than the main canvas chrome.

### Floating contextual action bar

- The Session screen keeps a floating contextual action bar separate from the minimal identity header.
- This bar is the shared full-page action pattern also used by Project Detail.
- On Session, the bar should prioritize session utilities and deeper execution actions rather than task-summary content.

### Conversation canvas

- The conversation is the dominant surface of the page.
- The user should land directly in the conversation with the composer ready for the next turn.
- New shaping sessions should begin with an empty composer rather than a seeded starter prompt.
- No large checkpoint, resumability summary, or task brief should compete with the latest conversation turns by default.

### Bottom execution rail

- Live execution state should stay visible near the composer, where the user is actively working.
- This rail shows current runtime state rather than becoming the place for every deeper git action.

### Right companion panel

- A right-side companion panel opens by default when the current session kind actually has one.
- Its open/closed state should be remembered per session.
- Task-backed sessions use this panel for task context and nearby session visibility that support the current conversation.
- Shaping sessions use this panel for draft proposal review and decision-making.
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
  - toggle right panel for task-backed and shaping sessions only
- `Close session` is a true session-level action and is a better fit here than `Complete task`.
- `Close session` should ask for confirmation only when the agent is currently running or when a shaping session still has undecided proposals that would be discarded.
- The action bar may expose git and workspace actions, but it should avoid turning into a dense always-expanded control deck.
- Scratch sessions should omit the right-panel toggle entirely.

## Execution rail contents

- The bottom execution rail should stay always visible near the composer.
- It should show the current execution state at a glance:
  - branch
  - repo-root versus managed-worktree mode
  - dirty or uncommitted-change indicator
- The rail should emphasize current state, while richer git actions stay discoverable from the action bar.
- This keeps live runtime visibility near the composer and reserves the action bar for deeper execution changes.
- Collision awareness can layer onto the rail later, but it is not part of the required day-one information set for the Session mock.

## Right-panel contents

### Task-backed session panel

- For task-backed sessions, the right panel should lead with task metadata first.
- Recommended section order for task-backed sessions:
  1. task metadata
  2. notes / description / context
  3. active sibling sessions on the same task
- Task metadata here may include the task title, status, priority, due date, labels, and collection when present.
- The task status control should live in this panel rather than in the action bar or execution rail.
- Notes remain supportive context rather than the main surface of the page.
- Sibling-session visibility should stay limited to active sibling sessions in Phase 1.

### Scratch session variant

- Scratch sessions do not have a right panel, do not expose task-status controls, and should keep the conversation shell clean rather than substituting project-context filler.
- The absence of a panel is part of the scratch posture, not an incomplete state.

### Shaping session panel

- Shaping sessions use the right panel as a tasks-only proposal companion panel rather than a task-context panel.
- This panel should show a flat list of draft candidate task proposals for the current shaping session.
- Proposal cards should remain editable while they are still being shaped.
- Each proposal card can be in one of three visible states:
  - open
  - accepted
  - rejected
- The user should be able to accept or reject proposals individually.
- The panel may also offer a bulk **Accept all** action.
- Accepted and rejected cards remain visible until the session is closed so the user can reconsider and reverse the decision if needed.
- The list should stay ordered with open proposals first, then accepted proposals, then rejected proposals.
- The companion panel does not need separate collection or cleanup proposal cards; those outcomes can still be driven by the shaping conversation itself.
- Accepted proposals remain staged during the shaping session and do not need to appear on the project board until the shaping session is finalized.

## Task status and session closure rules

- The MVP does not add a standalone `Complete task` control on the Session screen.
- Task completion remains status-driven for task-backed sessions.
- Moving a task into a `done`-bucket status is what closes that task in MVP.
- Task status changes may happen from the Session screen, but they should happen through the task-backed right-panel status control.
- Scratch sessions are unaffected by task status because they are not task-backed.
- Shaping sessions are also unaffected by task status because they are project-scoped rather than task-backed.
- Closing a shaping session should be silent when every proposal has already been accepted or rejected.
- If a shaping session still has undecided proposals, closing it should confirm that those undecided proposals will be discarded.
- Session closure is a separate session-level action and should not be conflated with task completion.

Canonical task and runtime semantics live in:

- `docs/product/task-model.md`
- `docs/architecture/execution-model.md`

## Sibling-session visibility and runtime awareness

- Active sibling-session visibility belongs in the task-backed right panel for awareness, not for redefining a primary session model.
- The current Session mock should emphasize branch, execution-root mode, and dirty state first.
- Collision warnings can layer on later without changing the core shell described here.
- Canonical runtime warning semantics live in `docs/architecture/execution-model.md`.

## Relationship to Home, Project Detail, and Task Detail

- Home is the minimal re-entry surface that gets the user back into a session quickly.
- Project Detail is the deliberate project-scoped backlog surface.
- The Task Detail modal is the compact bridge from a task on the board into execution.
- The Session screen is where the actual agent work happens, whether the session is task-backed, scratch, or shaping.
- Project Detail and Session share the floating contextual action-bar pattern, while the Task Detail modal remains the lighter modal exception.
- Scratch sessions bypass the Task Detail modal because they are not task-backed.
- Shaping sessions also bypass the Task Detail modal because they are project-scoped and not attached to tasks.

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
- Live board updates while a shaping session is still staging proposals.
