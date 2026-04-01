# Isagi documentation

These docs define the current MVP direction for Isagi: a desktop-first task and session orchestration tool for repo-based work.

## Where things go

- `docs/architecture/`: Architectural docs.
- `docs/journeys/`: User workflows.
- `docs/product/`: Vision and product docs (framing, scope, models, strategic artifacts).

## Source of truth

- **[docs/product/mvp-scope.md](docs/product/mvp-scope.md)** - canonical build scope and implementation priorities. For MVP decisions, this wins.
- **[docs/architecture/system-architecture.md](docs/architecture/system-architecture.md)** - zoomed-out system boundaries, deployment modes, harness placement, and trust assumptions.
- **[docs/product/collection-model.md](docs/product/collection-model.md)** - canonical collection definition and grouping semantics.
- **[docs/product/task-model.md](docs/product/task-model.md)** - canonical task definition and schema-level task semantics.
- **[docs/product/mental-model.md](docs/product/mental-model.md)** - core concepts, invariants, and lifecycle semantics.
- **[docs/product/overview.md](docs/product/overview.md)** - product framing and intended value.
- **[docs/product/value-proposition-canvas.md](docs/product/value-proposition-canvas.md)** - strategic customer/value framing (not implementation scope).

## Index

### docs/architecture/

- [docs/architecture/execution-model.md](docs/architecture/execution-model.md)
- [docs/architecture/system-architecture.md](docs/architecture/system-architecture.md)

### docs/journeys/

- [docs/journeys/coding-workflow.md](docs/journeys/coding-workflow.md)

### docs/product/

- [docs/product/collection-model.md](docs/product/collection-model.md)
- [docs/product/config/agent-guidance-projections.md](docs/product/config/agent-guidance-projections.md)
- [docs/product/config/project-task-git-rules.md](docs/product/config/project-task-git-rules.md)
- [docs/product/mental-model.md](docs/product/mental-model.md)
- [docs/product/mvp-scope.md](docs/product/mvp-scope.md)
- [docs/product/overview.md](docs/product/overview.md)
- [docs/product/screens/home-screen.md](docs/product/screens/home-screen.md)
- [docs/product/screens/project-detail-screen.md](docs/product/screens/project-detail-screen.md)
- [docs/product/screens/project-registration-flow.md](docs/product/screens/project-registration-flow.md)
- [docs/product/screens/project-settings-sheet.md](docs/product/screens/project-settings-sheet.md)
- [docs/product/screens/session-screen.md](docs/product/screens/session-screen.md)
- [docs/product/screens/task-detail-modal.md](docs/product/screens/task-detail-modal.md)
- [docs/product/task-model.md](docs/product/task-model.md)
- [docs/product/value-proposition-canvas.md](docs/product/value-proposition-canvas.md)

## Conventions

- Keep docs concise but explicit on invariants.
- Avoid duplicating deep mechanics across files; link to the owning doc instead.
- Keep zoomed-out system boundaries in `docs/architecture/system-architecture.md` and runtime mechanics in `docs/architecture/execution-model.md`.
- Prefer explicit session-type terminology in active docs; use `project` for repo containers.
