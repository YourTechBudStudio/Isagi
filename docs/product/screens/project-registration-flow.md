# Project Registration Flow (MVP)

**Last updated:** 2026-03-31

## One-liner

The Project Registration flow answers: **"How do I bring an existing backend-visible repo into Isagi with minimal setup?"**

## Primary job

- Register an existing git repo visible to the active backend as a project.
- Keep setup lightweight so the user can reach task and session work quickly.
- Use one command-driven registration flow everywhere the product needs project creation.

## Flow posture

- Registration is repo-first.
- Registration is low-ceremony.
- Validation should happen in context, with immediate recovery when input is wrong.

## Core principles

- The flow starts from selecting an existing backend-visible repo, not from creating a new project template.
- The MVP uses the same command-palette-backed flow for first-run and later project additions.
- Required input should stay minimal: a valid git repo path visible to the active backend and a confirmed project name.
- In local mode, a folder picker may be used as a convenience for selecting that path.
- In remote mode, registration may require direct entry of a path visible to the remote backend.
- The user may accept an inferred name or edit it before registration completes.
- Validation failures should keep the user in the same flow so retry is immediate.
- Registration should not force deeper workflow or git-configuration decisions before the project is usable.
- Success should confirm availability and offer obvious next steps without forcing navigation.

## Key boundaries

- This flow does not create or clone repositories.
- This flow does not require upfront status, alias, or git-mode configuration.
- This flow does not need a separate dedicated onboarding page in the MVP.

## Canonical references

- `docs/product/config/project-task-git-rules.md`
- `docs/product/screens/home-screen.md`
- `docs/journeys/coding-workflow.md`
