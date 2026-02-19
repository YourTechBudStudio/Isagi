# Area/Project/Task Rules

**Last updated:** 2026-02-19

This document defines configuration-level rules and defaults for area/project/task behavior.

## Core object responsibilities

- **Area**
  - owns rule templates and defaults
  - declares git mode
  - declares area-level execution defaults
- **Project**
  - groups tasks
  - can override execution defaults
  - may be repo-backed depending on area git mode
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

## Area git mode and constraints

Allowed per-area values:

- `none`
- `area_repo`
- `project_repo`

Rules:

- one fixed mode per area
- no mixed mode ambiguity inside the same area

## Project creation requirements by git mode

- if `none`: project does not require repo setup
- if `area_repo`: area repo is available; project may still define execution defaults
- if `project_repo`: project creation must initialize repository state
  - clone from URL, or
  - init empty repo

## Command templates and start behavior

Start behavior should be defined by templates/rules, not hardcoded task types.

Template-controlled options can include:

- empty-session start
- setup-required start
- starter prompt auto-send
- policy constraints by area/project

## Future extension points (workflows later)

Deferred by design:

- workflow-specific deep pipelines
- richer policy graphs across areas
- expanded command catalogs per domain

MVP goal is a stable generic core, then layered workflow specialization.
