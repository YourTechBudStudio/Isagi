# Execution Model

**Last updated:** 2026-02-26

This document defines runtime execution behavior for tasks, sessions, and git-backed environments.

## Path conventions

`area root` means the canonical filesystem root for one area.

Conventions:

- each area has one stable area root directory
- project directories live under their parent area root
- task execution roots resolve to either area root or project root per resolver/defaults

Area storage mode implications (v1):

- `area_monorepo`: area root is git-backed; projects are subpaths under the area repo
- `resource_repos`: work is split across multiple git roots (typically one per resource)

Resources semantics live in `docs/architecture/resources-model.md`.

## Workspace layout (v1)

MVP uses a single canonical workspace root.

Conceptual layout:

```txt
workspace/
  areas/
    <area-id>/
      area.yaml
      resources/
        <resource-name>/
      projects/
        <project-id>/
          project.yaml
          resources/
            <resource-name>/
```

Remarks:

- workspace paths are derived from ownership + naming; identity is not the path
- tasks may create worktrees/branches under an execution root, but the workspace remains the canonical place to find them

## Execution root resolver

Execution root is resolved deterministically in this order:

1. task-level override
2. project default
3. area default
4. area root fallback

This resolver applies regardless of area storage mode.

## Execution scope

In v1, tasks have an execution scope only.

- execution scope determines the default working directory/root for sessions and commands
- v1 does not define a separate access scope; safety posture is safe-by-review

`safe-by-review` means changes are made in git-backed working copies so they are inspectable and reviewable (diff/history) before being shared or merged.

## Area storage modes (`area_monorepo | resource_repos`)

Each area declares one fixed storage mode:

- `area_monorepo` - area-level repository is the canonical git root
- `resource_repos` - work is composed from multiple git roots (typically one per resource)

When `resource_repos` is used, resource creation requires either:

- clone from URL, or
- initialize empty local repo.

## Task/session/worktree relationship

- Task is the execution anchor.
- A task can have multiple sessions.
- A task may have one attached worktree lifecycle.
- Worktree lifecycle is tied to task lifecycle, not session lifecycle.
- If a task has an attached worktree, sessions for that task reuse it.

## Worktree isolation

Worktrees provide task-level isolation.

Requirements:

- worktrees are created per-task (not shared across tasks)
- a task reuses its attached worktree across sessions
- close-task cleanup deletes the task worktree and branch on successful close

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

## Power mode (multi-repo context)

Power mode indicates that a session may operate across multiple git roots in one execution context.

UI requirements:

- persistent badges: `Power Mode`, `Multi-repo Context`

Safety posture:

- default behavior remains safety-gated close (blocking) when checks definitively show unresolved state
- in power mode, checks that cannot be made definitive across multiple roots may be downgraded to warn-only with explicit user confirmation (as defined in `docs/mvp-scope.md`)

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
