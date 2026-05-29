# Isagi Docs

This directory holds durable product, architecture, and system-model documentation for Isagi.

## What belongs here

Use these docs for context that should survive individual milestones, implementation slices, and short-lived planning threads:

- product purpose and positioning
- shared terminology
- core product primitives
- high-level architecture
- configuration concepts
- durable design principles

## What does not belong here

Do not use these docs as the place for active milestone execution, task breakdowns, or implementation checklists. Those details change quickly and should live in the project's planning system instead.

These docs should explain the shape of Isagi without becoming a running transcript of every decision.

## Reading order

1. [`product-foundation.md`](./product-foundation.md) — what Isagi is and why it exists
2. [`product-model.md`](./product-model.md) — the shared nouns and mental model
3. [`architecture.md`](./architecture.md) — the high-level server/client architecture
4. [`configuration-model.md`](./configuration-model.md) — how configuration is conceptually organized

## Docs map

- **Product Foundation**: the core problem, value proposition, promise, and product principles.
- **Product Model**: the seven primary primitives: global config, project, worktree, environment, command, surface/panel, and attention signal.
- **Architecture**: Electron client plus server/runtime architecture, source-of-truth principles, and integration posture.
- **Configuration Model**: global/project/worktree configuration layers, command persistence, templates, presets, and agent-assisted configuration direction.
