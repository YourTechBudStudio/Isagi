# Area/Project/Task Rules

**Last updated:** 2026-02-26

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
  - command template defaults
- project:
  - `id`
  - parent area reference
  - optional execution root override
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
