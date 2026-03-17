# Project Settings Sheet (MVP)

**Last updated:** 2026-03-15

## One-liner

The Project Settings sheet answers: **"Where do I configure this repo-project without cluttering the daily backlog surface?"**

## Primary job

- Provide a secondary configuration surface for one project.
- Keep project-level setup such as repo defaults, task statuses, and terminology out of the everyday backlog view.
- Give users a clear place to adjust project behavior after registration.

## Non-goals

- Replacing Project Detail as the main workboard.
- Becoming a daily workflow surface.
- Duplicating task or session execution controls.
- Owning project rename, saved views, or collection-instance management.

## Surface posture

- Project settings are secondary to daily task and session work.
- The surface exists as a right-side sheet for deliberate configuration, not fast re-entry or backlog scanning.

## Entry points

- The primary in-product entry point is the **Project Detail** contextual action bar.
- Project registration success may also offer `Open settings` as a follow-up action.

## Information hierarchy

- Start with project-level configuration that shapes task and session behavior.
- Phase 1 Project Settings should focus on:
  - repository reference / repo-path management
  - default git mode
  - task statuses
  - display aliases (`Task label`, `Collection label`)
- Keep field-level semantics consistent with the canonical project config docs.
- Preserve a clean separation between project configuration and task/backlog manipulation.

## Recommended settings structure

The MVP settings surface should stay tight and deliberate.

Recommended section order:

1. **Repository**
2. **Default Git Mode**
3. **Task Statuses**
4. **Display Aliases**

This keeps the screen focused on project-wide behavior and meaning rather than live backlog structure.

## Repository section

- Project rename belongs on **Project Detail** as part of visible project identity, not in Project Settings.
- Project Settings should show the registered repo path / repo reference and provide a deliberate `Change repo path` action.
- Changing the repo path is a high-risk action.
- When the repo path changes:
  - tasks remain on the project
  - existing sessions are archived
  - archived sessions cannot be resumed
- The repo-path change flow should make these consequences explicit before confirmation.

## Task statuses

- Project Settings is the Phase 1 home for configuring task statuses.
- Users should be able to:
  - create statuses
  - edit status names
  - delete statuses
  - reorder statuses
  - map each status to a global bucket (`todo`, `in_progress`, `done`)
- Status order matters:
  - it expresses expected task progression posture
  - it determines grouped ordering in kanban and list views when grouped by status
- Phase 1 does not include status automation rules or hooks.

## Display aliases

- The sheet should keep the `Display Aliases` framing in the UI.
- The sheet should expose:
  - **Task label**
  - **Collection label**
- `Task label` is presentation-only.
- `Collection label` defaults to `Milestone` in the UI.
- These aliases are presentation-only, even if the underlying implementation represents them through a default collection-kind definition for future compatibility.

## What stays out of Project Settings

- Project name editing lives on **Project Detail**.
- Collection instances are managed from **Project Detail**, not Project Settings.
- Saved views are created, edited, and managed from **Project Detail**.
- Default task labels are not part of the Phase 1 Project Settings surface.

## Relationship to project config docs

- Canonical config semantics live in `docs/product/config/project-task-git-rules.md`.
- This screen is the UI surface for editing project configuration, not the source of truth for model semantics.

## Out of scope / future phase notes

- Rich analytics or reporting.
- Cross-project settings management.
- Team permissions or multi-user administration.
