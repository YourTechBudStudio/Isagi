# Project Registration Flow (MVP)

**Last updated:** 2026-04-28

## One-liner

The Project Registration flow answers: **"How do I bring an existing backend-visible repo into Isagi with minimal setup?"**

## Primary job

- Register an existing git repo visible to the active backend as a project.
- Keep setup lightweight so the user can reach continuation work quickly.
- Use one command-driven registration flow everywhere the product needs project creation.

## Flow posture

- Registration is repo-first for the MVP.
- Registration is low-ceremony.
- Validation should happen in context with immediate recovery.

## Core principles

- The flow starts from selecting an existing backend-visible repo, not creating a new project template.
- Required input should stay minimal: a valid git repo path and confirmed project name.
- In local mode, a folder picker may help select that path.
- In remote mode, registration may require direct entry of a backend-visible path.
- Registration should not force deeper workflow or git-configuration decisions before the project is usable.
- An initialized project may contain or later create `.isagi/` planning/config artifacts.

## Key boundaries

- This flow does not create or clone repositories.
- This flow does not require upfront status, prompt-template, or git-mode configuration.
- Multi-repo project registration is out of scope for the MVP.

## Canonical references

- `docs/product/planning-artifacts.md`
- `docs/product/config/project-task-git-rules.md`
- `docs/product/screens/home-screen.md`
- `docs/journeys/coding-workflow.md`
