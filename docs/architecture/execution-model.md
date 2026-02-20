# Execution Model

**Last updated:** 2026-02-19

This document defines runtime execution behavior for tasks, sessions, and git-backed environments.

## Path conventions

`area root` means the canonical filesystem root for one area.

Conventions:

- each area has one stable area root directory
- project directories live under their parent area root
- task execution roots resolve to either area root or project root per resolver/defaults

Git mode implications:

- `none`: execution root is filesystem-only (no required git semantics)
- `area_repo`: area root is git-backed; projects are subpaths under the area repo
- `project_repo`: each project root is independently git-backed

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

Setup failure semantics:

- surface full error details in-session
- provide explicit retry action
- if setup failed before any successful task session turn, cleanup may remove failed setup artifacts (for example stale worktree/branch) so retry starts clean
- do not auto-delete established worktrees that have already been used by successful sessions

## Close task behavior (verification, blocking, cleanup)

Close-task flow:

1. run verification checks for task repo/worktree state
2. if unresolved, block close and show clear reason/output
3. if resolved, complete close

Verification intent:

- prevent silent loss of unresolved task changes
- allow close only when state is verifiably resolved or explicitly discarded

On successful close:

- mark task done
- close all task sessions
- delete task worktree and branch

On failed close verification:

- task remains open
- user can inspect details and retry later

Manual override:

- explicit discard can be used as an intentional force-resolve path

## Sync policy and network requirements

- sync policy is hybrid: background sync plus manual sync command
- background sync targets default-branch refs used for close verification
- manual sync can be triggered from command surfaces for the currently relevant branch context
- close verification runs on `Close task` action
- if network is unavailable for required verification, close is blocked with explicit message

## Out-of-scope for MVP

- Full in-app PR lifecycle management.
- Full in-app merge conflict resolution UI.
- Release/deploy orchestration.
