# Project Detail Screen (MVP)

**Last updated:** 2026-03-11

## One-liner

The Project Detail screen answers: **"Where is this repo-project right now, and what should I pick up next?"**

## Primary job

- Act as the deliberate project-scoped backlog surface for one repo project.
- Help the user understand current work shape without turning into an analytics dashboard.
- Make it easy to inspect, organize, and pick the next actionable task.
- Support planning and backlog cleanup through a dedicated planning task opened with a PM agent session when needed.

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
- Sessions remain attached to tasks, even when the page includes planning or organizational actions.

## Information hierarchy

### Project identity and view context

- The top of the page should establish the project identity clearly.
- Saved views should be directly accessible as tabs.
- The page should remember the last-used view for that project.

### Project empty state

- If the project has no tasks yet, the page should shift from backlog scanning to a clear empty state.
- The empty state should explain that there is no actionable project work yet.
- Primary shaping action: **Plan with PM agent**.
- `Plan with PM agent` fits projects whose backlog still needs shaping or cleanup.
- **New task** and **New collection** are the main manual follow-up actions when the user wants to seed the board directly.
- The empty state should keep the user focused on creating visible board work rather than jumping straight into a project-level execution shortcut.

### Common actions first

- Common project actions should stay visible and consistent with the session surface action-bar pattern.
- The primary planning action is **Plan with PM agent**.
- These actions are backlog-shaping controls first, not execution-first shortcuts.
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
  - `Plan with PM agent`
  - `New task`
  - `New collection`
  - `Project settings`
  - filter controls
  - view customization controls
- The goal is consistency of action handling, not identical button sets across pages.
- `Project settings` should open the Project Settings screen described in `docs/product/screens/project-settings-screen.md`.

## Saved views

- Projects may have multiple saved views exposed as tabs.
- A project starts with default **Board** and **List** views, but users may edit, delete, or add views later.
- Saved views may control layout, grouping, filters, and sorting without changing canonical task semantics.
- The project should reopen into the last-used view rather than forcing one static default forever.
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
- Clicking the main body of a task row/card should open the Task Detail sheet for inspection and lightweight editing.
- Each task should also show a subtle session affordance:
  - `Start session` when no session exists yet
  - `Resume` when there is an existing open session, targeting the latest open session first
  - a lightweight active indicator when a session is currently live
- The task-level session affordance is the direct path into execution, while task selection itself should open the sheet first.
- These affordances should stay visually secondary so the board does not collapse into a session list.

## Task detail side sheet

- Clicking a task should open a right-side detail sheet rather than a full page.
- The sheet should stay thin and action-oriented so the board remains the primary backlog surface.
- Task rows/cards expose subtle session affordances, and the detail sheet expands that into task-specific action and context.
- The detail sheet is the canonical bridge between board selection and execution on Project Detail.
- Canonical task-sheet behavior lives in `docs/product/screens/task-detail-sheet.md`.

## Project manager agent

- **Plan with PM agent** starts a normal session that uses a specialized project-manager agent.
- This planning flow starts against the project as a whole rather than the currently selected view or filter context.
- Launching that flow should create or resume a dedicated planning task inside the project so the session still follows the invariant that every session belongs to a task.
- Its main role is backlog planning, organization, cleanup, and identifying next work.
- Once started, it appears in the existing session/sidebar model like any other session rather than introducing a separate concept.

## Collections on the page

- Collections are one of the available grouping and filtering dimensions on Project Detail.
- They should not dominate the default information hierarchy.
- Users may create collection-centric views when helpful, but the MVP does not require a dedicated collections-first default tab.

## Out of scope / future phase notes

- Rich project analytics or health scoring.
- Calendar-specific treatment as a first-class default layout.
- Roll-up or portfolio views across repo projects.
- A separate collection workflow/status model.
