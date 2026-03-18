# Project Detail Screen (MVP)

**Last updated:** 2026-03-17

## One-liner

The Project Detail screen answers: **"Where is this repo-project right now, and what should I pick up next?"**

## Primary job

- Act as the deliberate project-scoped backlog surface for one repo project.
- Help the user understand current work shape without turning into an analytics dashboard.
- Make it easy to inspect, organize, and pick the next actionable task.
- Support shaping and backlog cleanup through project-scoped shaping sessions when needed.

## Non-goals

- Replacing Home as the fast re-entry surface.
- Replacing the session surface as the primary execution UI.
- Becoming a portfolio or cross-project planning layer.
- Turning collection management into a second workflow system.
- Introducing a separate `Complete task` action distinct from task status.

## Page posture

- Project Detail is **repo-scoped**, not global.
- Project Detail is **task-centric**, not session-centric.
- The page is a workboard for understanding backlog shape and choosing next work.
- Tasks remain the primary board unit, while shaping stays a separate tracked session lane launched from project context.

## Information hierarchy

### Project identity and view context

- The top of the page should establish the project identity clearly.
- The project name should be editable inline on Project Detail rather than hidden in Project Settings.
- Saved views should be directly accessible as tabs.
- The page should remember the last-used view for that project.

### Project empty state

- If the project has no tasks yet, the page should shift from backlog scanning to a clear empty state.
- The empty state should explain that there is no actionable project work yet.
- The empty state should expose two clear next steps:
  - **Shape what's next**
  - **Start ad-hoc session**
- `Shape what's next` is the user-facing entry point into the Shaper agent for projects whose backlog still needs shaping or cleanup.
- That action opens a project-scoped shaping flow rather than creating a shaping task on the board.
- `Start ad-hoc session` fits projects where the user wants to begin visible tracked work immediately through a task-backed ad-hoc session.
- Manual actions such as **New task** and **New collection** still exist, but they are secondary to the empty-state CTA pair.

### Common actions first

- Common project actions should stay visible and consistent with the session surface action-bar pattern.
- The primary shaping action is **Shape what's next**, which opens the project-scoped shaping flow.
- These actions are persistent page-level controls, even when the project empty state presents a more specific CTA pair.
- Secondary actions include **New task**, **New collection**, **Project settings**, and view/filter controls.

### Tasks as the main surface

- The main body of the page is the current saved view over tasks.
- Tasks remain the primary unit shown in both board and list layouts.
- Collections are available for grouping and filtering, but they are not a primary dedicated section by default.

## Shared contextual action bar

- Project Detail should reuse the same contextual action-bar style as the session surface for common actions.
- Canonical shared-pattern guidance lives in `docs/product/screens/session-screen.md`.
- This shared style should keep placement, density, and interaction posture familiar across surfaces, even when the actions differ.
- On Project Detail, that bar should emphasize project-scoped actions such as:
  - `Shape what's next`
  - `New task`
  - `New collection`
  - `Project settings`
  - filter controls
  - view customization controls
- The goal is consistency of action handling, not identical button sets across pages.
- `Project settings` should open the Project Settings sheet described in `docs/product/screens/project-settings-sheet.md`.
- That settings surface owns workflow semantics and repo-level defaults rather than live backlog structure such as saved views or collection instances.

## Saved views

- Projects may have multiple saved views exposed as tabs.
- A project starts with default **Board** and **List** views, but users may edit, delete, or add views later.
- Saved views may control layout, grouping, filters, and sorting without changing canonical task semantics.
- The project should reopen into the last-used view rather than forcing one static default forever.
- Saved views are created, edited, and managed from Project Detail rather than Project Settings.
- Canonical saved-view configuration rules live in `docs/product/config/project-task-git-rules.md`.

## Default views

### Board

- Default grouping: **status**.
- Best for quick visual scanning of work shape.

### List

- Default grouping: **status**.
- Default sorting: **due date**, then **priority**.
- Best for denser inspection and lightweight backlog management.

## Task rows and cards

- Each task row/card should expose lightweight metadata for quick scanning.
- Helpful metadata may include status, priority, due date, labels, and collection when present.
- Clicking the main body of a task row/card should open the Task Detail modal for inspection and lightweight editing.
- Each task should also show a subtle session affordance:
  - `Start session` when no session exists yet
  - `Resume` when there is an existing open session, targeting the latest open session first
  - a lightweight active indicator when a session is currently live
- The task-level session affordance is the direct path into execution, while task selection itself should open the sheet first.
- These affordances should stay visually secondary so the board does not collapse into a session list.

## Task detail modal

- Clicking a task should open a centered detail modal rather than a full page.
- The modal should stay compact and action-oriented so the board remains the primary backlog surface.
- Task rows/cards expose subtle session affordances, and the modal expands that into task-specific action and context.
- The modal is the canonical bridge between board selection and execution on Project Detail.
- Canonical task-modal behavior lives in `docs/product/screens/task-detail-modal.md`.

## Shaper agent

- **Shape what's next** is the primary entry point into the Shaper agent.
- Shaping always starts against the project as a whole rather than the currently selected view or filter context.
- If no shaping sessions exist for the project, the action should start a new shaping session immediately.
- If shaping sessions already exist, the action should first open a small launcher before execution begins.
- That launcher should list recent shaping sessions sorted by recency.
- Each launcher row should show only the session title and last interaction time.
- The launcher should also offer **Start new shaping session**.
- New shaping sessions should use a simple project-based default title.
- New shaping sessions should begin with an empty composer rather than a seeded starter prompt.
- Shaping sessions are tracked and resumable, and they appear in Home and the sidebar like other sessions.
- Shaping sessions do not create or reuse board tasks and should not appear on the board as task rows/cards.
- The shaping companion panel is a tasks-only proposal list of draft candidate tasks.
- Collection creation or broader backlog cleanup may still be outcomes of shaping, but those should happen through the conversation rather than separate non-task cards in the companion panel.
- Accepted proposals remain staged during the shaping session and become visible on the board only after the shaping session is finalized and closed.
- Its main role is backlog shaping, organization, cleanup, and identifying next work.

## Collections on the page

- Collections are one of the available grouping and filtering dimensions on Project Detail.
- They should not dominate the default information hierarchy.
- Collection instances are managed from Project Detail as operational backlog structure rather than from Project Settings.
- Users may create collection-centric views when helpful, but the MVP does not require a dedicated collections-first default tab.

## Out of scope / future phase notes

- Rich project analytics or health scoring.
- Calendar-specific treatment as a first-class default layout.
- Roll-up or portfolio views across repo projects.
- A separate collection workflow/status model.
