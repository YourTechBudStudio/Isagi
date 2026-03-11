# Project Settings Screen (MVP)

**Last updated:** 2026-03-11

## One-liner

The Project Settings screen answers: **"Where do I configure this repo-project without cluttering the daily backlog surface?"**

## Primary job

- Provide a secondary configuration surface for one project.
- Keep project-level setup such as statuses, aliases, and defaults out of the everyday backlog view.
- Give users a clear place to adjust project behavior after registration.

## Non-goals

- Replacing Project Detail as the main workboard.
- Becoming a daily workflow surface.
- Duplicating task or session execution controls.

## Entry posture

- Project settings are secondary to daily task and session work.
- The screen exists for deliberate configuration, not fast re-entry or backlog scanning.

## Entry points

- The primary in-product entry point is the **Project Detail** contextual action bar.
- Project registration success may also offer `Open settings` as a follow-up action.

## Information hierarchy

- Start with project-level configuration that shapes task and session behavior.
- Typical settings here include project-defined statuses, display aliases, default git mode, saved views, and optional label or workflow defaults.
- Keep field-level semantics consistent with the canonical project config docs.
- Preserve a clean separation between project configuration and task/backlog manipulation.

## Relationship to project config docs

- Canonical config semantics live in `docs/product/config/project-task-git-rules.md`.
- This screen is the UI surface for editing project configuration, not the source of truth for model semantics.

## Out of scope / future phase notes

- Rich analytics or reporting.
- Cross-project settings management.
- Team permissions or multi-user administration.
