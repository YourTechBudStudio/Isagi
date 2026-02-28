# Area/Project/Task Rules

**Last updated:** 2026-02-28

This document defines configuration-level rules and defaults for area/project/task behavior.

## Expected filesystem layout

Minimal canonical layout (illustrative):

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

- Area and project IDs should be stable and filesystem-safe.
- ID values should match directory names to reduce ambiguity.
- Managed worktrees are not part of `workspace/`; they live under a separate workspace-sibling worktree root.

## Core object responsibilities

- **Area**
  - owns rule templates and defaults
  - declares storage mode
  - declares area-level execution defaults
- **Project**
  - groups tasks
  - can override execution defaults
  - may be repo-backed depending on area storage mode
- **Task**
  - execution unit
  - may override execution root
  - references command template for start behavior

## Defaults and override hierarchy

Execution root resolution order:

1. task override
2. project default
3. area default
4. area root fallback

This hierarchy should be explicit and deterministic.

## Worktree creation policy

Per-task worktree behavior is controlled by a policy enum:

- `ALWAYS` - create a new worktree at task start; fail if the target worktree already exists
- `IF_NOT_EXISTS` - create when missing, otherwise attach to existing worktree (system default)
- `NEVER` - require existing worktree; fail if missing

Worktree identity fields:

- `repo-key` and `branch-slug` are required identity fields for managed worktrees
- both fields must be normalized to sanitized filesystem-safe slugs before use (for example lowercase, separator-safe values)
- uniqueness is enforced on the normalized `(repo-key, branch-slug)` pair

Policy resolver hierarchy:

1. task override
2. project default
3. area default
4. system default (`IF_NOT_EXISTS`)

Timing:

- policy is resolved and snapshotted at task creation
- branch baseline for later merge checks is snapshotted at task creation
- policy enforcement and all git/worktree operations run at task start

Constraints:

- worktree assignment on task is immutable once set
- create/attach requires execution root to be inside a git repo
- policy violations fail task start and place the task in `error`; recovery requires manual cleanup and restart from blank task

## Area storage mode and constraints

Allowed per-area values (v1):

- `area_monorepo`
- `resource_repos`

Rules:

- one fixed mode per area
- no mixed mode ambiguity inside the same area
- v1 resources are git-backed only; attach/detach is out of scope

## Minimal config fields

Minimum expected fields (conceptual):

- area:
  - `id`
  - `storage_mode`
  - default execution root policy
  - default worktree creation policy (optional)
  - command template defaults
- project:
  - `id`
  - parent area reference
  - optional execution root override
  - optional worktree creation policy override
  - optional command template override

These are intentionally minimal to keep configuration evolvable in MVP.

## Project creation requirements by storage mode

- if `area_monorepo`: area repo is initialized/cloned once; projects are subpaths under it
- if `resource_repos`: project scaffolding creates the expected workspace subpaths; resources are initialized/cloned as git-backed units when created

## Command templates and start behavior

Start behavior should be defined by templates/rules, not hardcoded task types.

Template-controlled options can include:

- empty-session start
- setup-required start
- starter prompt auto-send
- policy constraints by area/project

Template declaration hierarchy:

- area declares default command templates
- project may override selected defaults
- task may reference a template and optionally override specific runtime parameters

## Future extension points (workflows later)

Deferred by design:

- workflow-specific deep pipelines
- richer policy graphs across areas
- expanded command catalogs per domain

MVP goal is a stable generic core, then layered workflow specialization.
