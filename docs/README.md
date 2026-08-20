# Isagi Docs

This directory holds durable product, architecture, and system-model documentation for Isagi.

## What belongs here

Use these docs for context that should survive individual epics, implementation slices, and short-lived planning threads:

- product purpose and positioning
- shared terminology
- core product primitives
- high-level architecture
- configuration concepts
- durable design principles

## What does not belong here

These docs should explain the shape of Isagi without becoming a running transcript of every decision.

## Reading order

1. [`product-foundation.md`](./product-foundation.md) — what Isagi is and why it exists
2. [`product-model.md`](./product-model.md) — the shared nouns and mental model
3. [`architecture.md`](./architecture.md) — the high-level server/client architecture
4. [`configuration-model.md`](./configuration-model.md) — how configuration is conceptually organized
5. [`workflow-engine.md`](./workflow-engine.md) — the durable workflow subsystem: engine, run-centric API, event surfaces, and client boundary
6. [`engineering-guidance/README.md`](./engineering-guidance/README.md) — coding and review guidance for keeping the repo maintainable
7. [`development-runtime.md`](./development-runtime.md) — maintainer commands, ownership topology, deterministic preparation, staging, and troubleshooting
8. [`issue-tracking-guidance.md`](./issue-tracking-guidance.md) — how epics and stories are represented in the repository's issue tracker, retrieved, and amended

## Docs map

- **Product Foundation**: the core problem, value proposition, promise, and product principles.
- **Product Model**: the seven primary primitives: global config, project, worktree, worktree environment, command, surface/panel, and attention signal.
- **Architecture**: Electron client plus server/runtime architecture, source-of-truth principles, and integration posture.
- **Configuration Model**: global/project/worktree configuration layers, command persistence, templates, presets, and agent-assisted configuration direction.
- **Workflow Subsystem**: the durable, in-process engine that runs user-authored reducer callbacks as restart-surviving state machines, plus the surrounding run-centric surface — run identity and the status/`paused` lifecycle, the resolver/dispatcher/recoverer loops, the `ctx` SDK and `wait`/`event` helpers, the run API and controls, the three event surfaces, and the web client boundary.
- **Engineering Guidance**: principles and review lenses for boundaries, module shape, drift prevention, runtime diagnostics, product behavior, and verification.
- **Development Runtime**: the command-accurate preparation and supervision flow, worktree isolation, runtime staging, packaging parity, the end-to-end release process, and the troubleshooting model used by maintainers.
- **Issue Tracking Guidance**: the repository-specific mapping for epics and stories — tracker fields, relationships, append-only amendments, retrieval, and the publication flow.
