# Isagi documentation

These docs define the current MVP direction for Isagi: a desktop-first context continuity engine for coding/product workflows.

## Source of truth

- **[MVP scope](./mvp-scope.md)** - canonical build scope and implementation priorities. For MVP decisions, this wins.
- **[Product overview](./product.md)** - product framing and intended value.
- **[Mental model](./mental-model.md)** - core concepts, invariants, and lifecycle semantics.
- **[Value Proposition Canvas](./value-proposition-canvas.md)** - strategic customer/value framing (not implementation scope).

## Core docs

- **[MVP scope](./mvp-scope.md)**
- **[Product overview](./product.md)**
- **[Mental model](./mental-model.md)**

## Journeys

- **[Coding workflow journey](./journeys/coding-workflow.md)** - step-by-step desktop journey from spark to completed task.

## Architecture

- **[Execution model](./architecture/execution-model.md)** - execution roots, storage modes, sessions, worktrees, and close-task safety.
- **[Resources model](./architecture/resources-model.md)** - durable resources, storage modes, and lifecycle semantics.

## Configuration

- **[Area/Project/Task rules](./config/area-project-task-rules.md)** - defaults, overrides, and rule hierarchy.

## Archived docs

- **[Mobile home screen (archived)](./archived/mobile-home.md)** - preserved for future mobile reactivation; not part of current MVP.

## Conventions

- Keep docs concise but explicit on invariants.
- Avoid duplicating deep mechanics across files; link to the owning doc instead.
- Prefer `area/project/task` terminology in active docs.
