# Execution Model

**Last updated:** 2026-02-28

This document defines runtime execution behavior for tasks, sessions, and git-backed environments.

## Path conventions

`area root` means the canonical filesystem root for one area.

`worktree root` means the workspace-sibling root where all managed git worktrees live.

`main workspace branch` means the branch in the main workspace repository that is snapshotted at task creation as the merge-target baseline for that task.

Conventions:

- each area has one stable area root directory
- project directories live under their parent area root
- task execution roots resolve to either area root or project root per resolver/defaults
- managed worktrees live under `worktree root`, not under `workspace/`
- worktree identity is globally unique by `(repo-key, branch-slug)`
- naming/normalization constraints for `repo-key` and `branch-slug` are defined in `docs/product/config/area-project-task-rules.md`

Area storage mode implications (v1):

- `area_monorepo`: area root is git-backed; projects are subpaths under the area repo
- `resource_repos`: work is split across multiple git roots (typically one per resource)

Resources semantics live in `docs/architecture/resources-model.md`.

## Workspace layout (v1)

MVP uses a single canonical workspace root.

Conceptual layout:

```txt
isagi-root/
  workspace/
    areas/
      <area-id>/
        AGENTS.md
        TRIAGE.md
        resources/
          <resource-name>/
        projects/
          <project-id>/
            resources/
              <resource-name>/
  worktrees/
    <repo-key>-<branch-slug>/
```

Remarks:

- workspace paths are derived from ownership + naming; identity is not the path
- execution root still determines command/session default working context
- managed worktrees are physically created under `worktree root`

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
- A task may include one immutable worktree assignment.
- Worktree assignment points to a globally unique `(repo-key, branch-slug)` identity.
- Multiple tasks may reference the same worktree identity.
- If a task has a worktree assignment, sessions for that task reuse that same worktree.

## Worktree isolation

Worktrees provide repo/branch-scoped execution environments.

Requirements:

- worktrees are not created during task creation; create/attach runs at task start
- worktree assignment is immutable once set on a task
- tasks may share a worktree; cleanup decisions are reference-aware
- active reference means another task that is started, not done, and not in error

## Start task behavior (command-driven)

Task start can run in two modes:

- empty chat session
- command-driven start flow

Command-driven start may include:

- environment setup
- optional starter prompt auto-send

Worktree policy timing:

- worktree creation policy resolves at task creation (task override -> project default -> area default -> system default)
- task creation snapshots worktree identity and branch baseline (source branch + merge target branch from the main workspace branch at creation time)
- all policy enforcement and git/worktree operations run at task start
- if execution root is not inside a git repo, no managed worktree is created
- branch baseline is validated at task start against the task snapshot

UI behavior:

- open task tab immediately
- show `Preparing environment...` only when setup is required

Setup failure semantics:

- surface full error details in-session
- provide explicit retry action for non-worktree setup failures
- if mapped worktree is missing, task enters `error`
- if source or merge-target branch snapshot has changed/been removed, task enters `error`
- worktree-related task errors are terminal; remedy is manual resolution/cleanup then restart task from blank state (existing task progress is not preserved)

## Close task behavior (verification, blocking, cleanup)

Close-task flow:

1. if another active task references the same worktree, skip verification checks and allow close
2. otherwise verify the mapped worktree still exists; if missing, task enters `error`
3. otherwise run verification checks for task repo/worktree state
4. if unresolved, block close and show clear reason/output
5. if resolved, complete close

Verification intent:

- prevent silent loss of unresolved task changes
- allow close only when state is verifiably resolved or explicitly discarded
- when checks run, dirty worktree state blocks close
- evaluate merge/deletability against the task's snapshotted merge target
- enforce non-force cleanup semantics equivalent to deletability under `git branch -d`

On successful close:

- mark task done
- close all task sessions
- when no active task references remain and checks pass, delete task worktree and branch

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
- in power mode, checks that cannot be made definitive across multiple roots may be downgraded to warn-only with explicit user confirmation (as defined in `docs/product/mvp-scope.md`)
- power mode does not auto-orchestrate worktrees across multiple repos; multi-repo worktree handling remains manual

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
