# Project Registration Flow (MVP)

**Last updated:** 2026-03-12

## One-liner

The Project Registration flow answers: **"How do I get an existing local repo into Isagi with the least setup overhead?"**

## Primary job

- Register an existing local git repo as a project in Isagi.
- Keep first-time setup lightweight so users can get to task and session work quickly.
- Use the same command-palette-backed flow for both first-run and later project additions.

## Non-goals

- Creating a new git repo from inside Isagi.
- Forcing full project configuration before the user can begin work.
- Becoming a heavyweight onboarding wizard with workflow templates or backlog setup logic.

## Flow posture

- Project registration is required because Isagi's project model is built around registered existing local git repos.
- The MVP flow is a command-palette wizard rather than a dedicated setup page.
- There is no separate project-registration screen in Phase 1.
- First-run entry points should launch this same flow rather than introducing a second registration implementation.

## Entry points

- Global command palette via an `Add project` command.
- Home empty states through a visible `Add your first project` CTA that launches the same command-palette wizard.

## Required inputs

The registration flow requires only:

- a local repo directory
- a project name confirmation step

The flow is repo-first:

1. The user provides a local repo directory.
2. Isagi derives a default project name from that folder.
3. The user may edit the inferred name before confirming registration.

The selected directory must point to an existing local git repo.

## Command palette interaction model

- `Add project` runs as a command-palette wizard.
- The first argument uses a custom `directory` input type.
- That directory step should support both:
  - pasting a local path directly into the palette
  - using a `Select` affordance that opens a folder-picker helper on top of the palette
- The folder picker is a helper for the current argument, not a separate registration flow.
- Once a valid directory is submitted, the palette advances to a text step with a preloaded inferred project name.
- The inferred name should be derived from the selected folder name by splitting `-` and `_` into spaces and converting the result into Title Case.
- The user can accept or edit that inferred name, then press Enter again to complete registration.

## Validation and retry

- The directory must exist locally.
- The directory must be an existing local git repo.
- Invalid input should surface inline inside the command palette rather than kicking the user into a separate error flow.
- The command palette should remain open after validation failure so the user can retry immediately.
- Error copy should explain that Isagi currently works only with existing local git repos.
- Standard command-palette backtracking behavior remains in place, so the user can move back to the directory step if the inferred name or selected path needs to change.

## Optional follow-up configuration

Project registration should not require additional setup before the project becomes usable.

Examples of configuration that may be added later:

- project-defined statuses
- collection aliases or other display aliases
- default git mode
- saved views
- labels or related workflow metadata

Canonical project-config semantics live in `docs/product/config/project-task-git-rules.md`.

## Success path

- Successful registration should confirm that the project is now available in Isagi.
- Registration success should keep the user in place rather than forcing immediate navigation.
- The success notification should offer:
  - `Open project` as the primary follow-up action
  - `Open settings`

## Relationship to Home and Project Detail

- Home owns the first-run empty state but should route project registration into this flow.
- Project Detail becomes the main backlog surface after a project has been registered.
- Project settings are a secondary follow-up surface for deeper configuration after registration.

## Out of scope / future phase notes

- Repo creation or cloning workflows.
- Registering remote HTTPS or SSH repo URLs directly.
- Bulk project import.
- Template-driven project setup.
- Mandatory status, alias, or git-mode configuration during first registration.
