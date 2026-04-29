# Project Detail Screen (MVP)

**Last updated:** 2026-04-28

## One-liner

The Project Detail screen answers: **"Where is this project's momentum, and what should continue next?"**

## Primary job

- Act as the deliberate project momentum surface.
- Help the user see milestones, tasks, sparks, and resumable sessions in project context.
- Provide the project-scoped entry point for Discovery and Shaping.

## Surface posture

- Project Detail is project-scoped, not global.
- It is for understanding and continuing project work, not running agent execution itself.
- It should make the next continuation opportunity visible without becoming heavy PM software.

## Core principles

- Milestones are the primary continuation object.
- Tasks remain important as reviewable execution chunks under milestone/project context.
- Discovery belongs here as the way to recover the next milestone when direction is unclear.
- Shaping belongs here as the way to turn a milestone into tasks.
- Planning artifacts are Git-backed files under `.isagi/`; UI can make them easier to navigate without replacing Git review.
- Empty states should move the user toward creating a spark, discovering a milestone, shaping tasks, or starting execution.

## Key boundaries

- Fast global re-entry belongs to `docs/product/screens/home-screen.md`.
- Execution belongs to `docs/product/screens/session-screen.md`.
- Project-level configuration belongs to `docs/product/screens/project-settings-sheet.md`.

## Canonical references

- `docs/product/planning-artifacts.md`
- `docs/product/mental-model.md`
- `docs/product/screens/session-screen.md`
