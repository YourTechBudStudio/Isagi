# Execution Model

**Last updated:** 2026-02-19

This document defines runtime execution behavior for tasks, sessions, and git-backed environments.

## Execution root resolver

Execution root is resolved deterministically in this order:

1. task-level override
2. project default
3. area default
4. area root fallback

This resolver applies regardless of area git mode.

## Git modes per area (`none | area_repo | project_repo`)

Each area declares one fixed git mode:

- `none` - no git lifecycle required for execution.
- `area_repo` - area-level repository is canonical git root.
- `project_repo` - each project is repository-backed.

When `project_repo` is used, project creation requires either:

- clone from URL, or
- initialize empty local repo.

## Task/session/worktree relationship

- Task is the execution anchor.
- A task can have multiple sessions.
- A task may have one attached worktree lifecycle.
- Worktree lifecycle is tied to task lifecycle, not session lifecycle.
- If a task has an attached worktree, sessions for that task reuse it.

## Start task behavior (command-driven)

Task start can run in two modes:

- empty chat session
- command-driven start flow

Command-driven start may include:

- environment setup
- optional starter prompt auto-send

UI behavior:

- open task tab immediately
- show `Preparing environment...` only when setup is required

## Close task behavior (verification, blocking, cleanup)

Close-task flow:

1. run verification checks for task repo/worktree state
2. if unresolved, block close and show clear reason/output
3. if resolved, complete close

On successful close:

- mark task done
- close all task sessions
- delete task worktree and branch

On failed close verification:

- task remains open
- user can inspect details and retry later

## Sync policy and network requirements

- Default branch sync runs in background (lightweight cadence).
- Manual sync can be triggered from command surfaces.
- Close verification can require network state; when unavailable, close is blocked with explicit message.

## Out-of-scope for MVP

- Full in-app PR lifecycle management.
- Full in-app merge conflict resolution UI.
- Release/deploy orchestration.
