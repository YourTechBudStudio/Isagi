# Isagi documentation

These docs define the current MVP direction for Isagi: a desktop-first continuation system for project momentum.

## Where things go

- `docs/architecture/`: Architectural docs.
- `docs/journeys/`: User workflows.
- `docs/product/`: Vision and product docs (framing, scope, models, strategic artifacts).

## Source of truth

- **[docs/product/mvp-scope.md](docs/product/mvp-scope.md)** - canonical build scope and implementation priorities. For MVP decisions, this wins.
- **[docs/product/overview.md](docs/product/overview.md)** - product framing and intended value.
- **[docs/product/mental-model.md](docs/product/mental-model.md)** - core concepts and invariants.
- **[docs/product/planning-artifacts.md](docs/product/planning-artifacts.md)** - canonical `.isagi/` planning artifact guidance.
- **[docs/architecture/system-architecture.md](docs/architecture/system-architecture.md)** - system boundaries, deployment modes, runtime ownership, harness placement, and trust assumptions.
- **[docs/architecture/execution-model.md](docs/architecture/execution-model.md)** - runtime execution mechanics.
- **[docs/product/value-proposition-canvas.md](docs/product/value-proposition-canvas.md)** - strategic customer/value framing.

## Index

### docs/architecture/

- [docs/architecture/execution-model.md](docs/architecture/execution-model.md)
- [docs/architecture/system-architecture.md](docs/architecture/system-architecture.md)

### docs/journeys/

- [docs/journeys/coding-workflow.md](docs/journeys/coding-workflow.md)

### docs/product/

- [docs/product/config/agent-guidance-projections.md](docs/product/config/agent-guidance-projections.md)
- [docs/product/config/project-task-git-rules.md](docs/product/config/project-task-git-rules.md)
- [docs/product/mental-model.md](docs/product/mental-model.md)
- [docs/product/mvp-scope.md](docs/product/mvp-scope.md)
- [docs/product/overview.md](docs/product/overview.md)
- [docs/product/planning-artifacts.md](docs/product/planning-artifacts.md)
- [docs/product/screens/home-screen.md](docs/product/screens/home-screen.md)
- [docs/product/screens/project-detail-screen.md](docs/product/screens/project-detail-screen.md)
- [docs/product/screens/project-registration-flow.md](docs/product/screens/project-registration-flow.md)
- [docs/product/screens/project-settings-sheet.md](docs/product/screens/project-settings-sheet.md)
- [docs/product/screens/session-screen.md](docs/product/screens/session-screen.md)
- [docs/product/screens/task-detail-modal.md](docs/product/screens/task-detail-modal.md)
- [docs/product/value-proposition-canvas.md](docs/product/value-proposition-canvas.md)

## Conventions

- Keep docs concise but explicit on invariants.
- Avoid duplicating deep mechanics across files; link to the owning doc instead.
- Durable planning state belongs in Git-backed `.isagi/` artifacts.
- Runtime/session state belongs to the backend.
- Keep zoomed-out system boundaries in `docs/architecture/system-architecture.md` and runtime mechanics in `docs/architecture/execution-model.md`.
