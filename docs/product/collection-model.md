# Collection Model (MVP)

**Last updated:** 2026-03-06

## One-liner

A collection is an optional project-local grouping container for related tasks.

## Why collections exist

- Collections let a repo project organize related tasks around a broader outcome without changing the execution model.
- They support workflows where the user thinks in larger groupings, such as a feature, initiative, or content unit, while keeping task as the actionable core.
- They reduce the pressure to overload task status, labels, or naming just to express grouping.
- Example: one repo project may represent a content workspace, one collection may represent a single video, and the tasks inside it may cover research, scripting, editing, or publishing steps.

## Collection definition

A collection is a project-owned grouping object.

Collections are:

- optional
- scoped to exactly one project
- used to organize tasks
- not execution surfaces

Collections do not own repo context, branch choice, worktree choice, or session identity.

## Collection invariants

1. Every collection belongs to exactly one project.
2. A collection does not redefine the project's execution root.
3. A task may belong to zero or one collection.
4. Sessions never attach directly to collections.
5. Collections are grouping-only in Phase 1; they do not carry a separate collection workflow/status model.

## Relationship to projects, tasks, and sessions

- A project may contain tasks directly, collections, or both.
- A collection groups related tasks inside that project.
- Some tasks may stay directly under the project when they do not belong to a broader grouping.
- A task remains the smallest actionable unit and may optionally reference a `collection_id`.
- Sessions attach to tasks only, even when those tasks are grouped under a collection.
- Collection membership does not change task status semantics or execution-root inheritance.

Related docs:

- `docs/product/task-model.md`
- `docs/architecture/execution-model.md`

## What collections are not

- not a replacement for projects
- not a roll-up or portfolio layer across repos
- not an execution root or git context
- not a session container
- not a second status context for the same task

## Aliasing and presentation

- Projects may rename `collection` in the UI for workflow fit.
- Aliases are presentation-only and do not change the canonical model term in docs or contracts.
- The same project may also alias other visible labels, but `task` remains the canonical actionable concept.
- Project-local alias configuration is described in `docs/product/config/project-task-git-rules.md`.

## Deferred / intentionally flexible

- richer collection metadata
- collection-specific views and saved layouts
- whether collections later gain their own lightweight status model
- roll-up / portfolio layers across repo projects
