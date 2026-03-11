# Project Registration Flow (MVP)

**Last updated:** 2026-03-11

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
- First-run entry points should launch this same flow rather than introducing a second registration implementation.

## Entry points

- Global command palette via an `Add project` command.
- Home empty states through a visible `Add your first project` CTA that launches the same command-palette wizard.

## Required inputs

The registration flow requires only:

- `project name`
- `repo path`

The repo path should point to an existing local git repo.

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
- The success notification should offer:
  - `Open project`
  - `Open settings`

## Relationship to Home and Project Detail

- Home owns the first-run empty state but should route project creation into this flow.
- Project Detail becomes the main backlog surface after a project has been registered.
- Project settings are a secondary follow-up surface for deeper configuration after registration.

## Out of scope / future phase notes

- Repo creation or cloning workflows.
- Bulk project import.
- Template-driven project setup.
- Mandatory status, alias, or git-mode configuration during first registration.
