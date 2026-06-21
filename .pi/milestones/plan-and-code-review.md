---
title: Plan & Code Review
status: candidate
created: 2026-06-21
updated: 2026-06-21
tags: [review, agents, worktrees]
---

# Summary

Make the human review loop first-class in Isagi: review an agent's plan *before* coding
starts, and review the resulting code *after* the work is done.

# Why this matters

Reviewing is core to how the user actually works, but today both ends are manual. There is
no structured place to read and approve a plan before an agent starts changing code, and
reviewing the result means juggling folder-sensitive VS Code windows across worktrees by
hand. Isagi's agent + worktree model is the natural home for both review points.

# Direction

Two halves of one loop:

1. Plan review (before coding) — a place to read, question, and approve or redirect an
   agent's intended plan before it edits code. Format and flow are exploratory.
2. Code review (after coding) — a usable path to review the active worktree's code/diff
   from inside Isagi, likely via a code-server / `editor` surface or a pragmatic
   browser-backed surface. (`worktree-continuity-code-review-surface`)

# Done condition

Done when, for a worktree, the user has a usable path to review an agent's plan before
approving work, and to review the resulting code without manually managing external editor
windows. Exact substrates can stay flexible.

# Boundaries

## In direction

- Plan-before-coding review as a first-class step.
- Code/diff review for the active worktree.
- Reuse the worktree surface substrate rather than reinventing windows.

## Out of direction

- A full PR / review-platform replacement.
- VS Code-native integration if code-server / browser-backed review is enough.

# Continue with

- Shape the plan-review slice — the unshaped half of this milestone (new).
- `worktree-continuity-code-review-surface` — the code-viewing slice. Depends on the
  browser/`editor` surface substrate from `worktree-continuity`, so it sequences after that
  substrate lands (or stubs it).

# Notes

Graduated from the Worktree Continuity milestone on 2026-06-21: code review was a single
"code review surface" task there. Promoting it to its own milestone adds the missing
plan-review half and treats review as one workflow — plan before, code after.
