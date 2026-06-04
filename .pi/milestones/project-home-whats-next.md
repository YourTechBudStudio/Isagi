---
title: Project Home & What's Next
status: candidate
created: 2026-05-31
updated: 2026-05-31
tags: [candidate, project-home, momentum, continuity, planning]
---

# Summary

Give each project a calm "what's next" home: a readable, ordered view of the next work
to pick up, so the moment a session ends the user can choose the next thing without
hunting through files.

# Why this matters

Momentum doesn't end when a session ends — it ends when the user can't quickly decide
what to do next. Finishing a session immediately raises "what do I pick up now?", and
today the file-based task list (e.g. `.pi/tasks`) is unordered and hard to scan. The
user can usually decide *which project*; the friction is *within* a project, picking the
next best task.

The value is preserving momentum across the gap *between* sessions — not adding a
project-management tool. Isagi should make the user's existing planning legible and
actionable, not own a task model.

# Direction

Explore a **project-level** "home" surface (not global, not per-worktree) that:

- presents the project's milestones/tasks in a **readable, ordered** way
- highlights the likely **next task(s)** to pick up
- reads from the user's **existing planning source** (e.g. `.pi/` milestones/tasks, or a
  project scratchpad) rather than inventing a parallel store
- offers a one-step hook from "next task" → **start a session** (and possibly name/seed
  the worktree from the chosen task)

This stays consistent with the product model: **tasks remain user-owned**; Isagi
provides a view plus a launch hook, not a first-class task system.

# Done condition

Not hardened yet.

A future milestone may be ready when we know:

- where the project's planning truth lives and how Isagi reads/orders it
- what "next" means (explicit order, recency, dependency, or user-curated)
- how much the home surface shows vs links out to
- how a "start a session from a task" hook interacts with the new-session wizard
- whether worktree naming should be seeded from the chosen task

# Boundaries

Keep parked until Worktree Continuity is dogfoodable; this builds on the
session/worktree/rail model.

Avoid turning this into a full task/milestone manager inside Isagi. It is a **momentum
surface over existing planning**, not a planning system.

Global project-switching decisions stay with the user; this helps *within* a project,
not across projects.

# Continue with

After Worktree Continuity proves the loop, run discovery on:

1. The planning source(s) Isagi should read and how to order them.
2. The minimal home layout that answers "what's next?" at a glance.
3. The launch hook: next task → new-session wizard, possibly pre-naming the worktree.
4. Whether this lives in the rail, as a project landing surface, or a canvas tab.

# Notes

Surfaced during the Worktree Continuity experience-design brainstorm as the "what's
next" moment after a session is marked done. Deferred from that milestone to keep scope
tight; captured here so the momentum-continuation value isn't lost.

Originated during the Worktree Continuity experience-design pass and was parked here
so the thought does not disappear.
