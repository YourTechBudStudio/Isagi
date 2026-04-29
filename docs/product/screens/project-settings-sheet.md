# Project Settings Sheet (MVP)

**Last updated:** 2026-04-28

## One-liner

The Project Settings sheet answers: **"Where do I configure project behavior without crowding day-to-day work?"**

## Primary job

- Provide a secondary configuration surface for one project.
- Hold project-level settings that shape task and session behavior.
- Keep durable project configuration separate from daily continuation work.

## Surface posture

- Project Settings is project-scoped and deliberate.
- It is for infrequent configuration, not rapid execution or milestone browsing.
- The sheet should feel tighter than the main work surfaces.

## Core principles

- Settings owns project-wide behavior, not live milestone/task structure.
- Durable project configuration should be Git-backed where practical, likely under `.isagi/config/`.
- Repository reference changes are high-risk and should make consequences explicit.
- Task-status configuration belongs here because it changes workflow semantics for the whole project.
- The sheet should not grow into cross-project administration or analytics.

## Key boundaries

- Milestones, tasks, sparks, and project momentum belong to `docs/product/screens/project-detail-screen.md`.
- Execution conversation does not belong here.
- Exact `.isagi/config/` files are intentionally deferred.

## Canonical references

- `docs/product/planning-artifacts.md`
- `docs/product/config/project-task-git-rules.md`
- `docs/product/screens/project-detail-screen.md`
