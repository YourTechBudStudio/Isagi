# Session Screen (MVP)

**Last updated:** 2026-04-28

## One-liner

The Session screen answers: **"How do I stay in the conversation while keeping enough context visible to avoid mistakes?"**

## Primary job

- Act as the conversation-first surface for live agent work.
- Support execution, scratch exploration, Discovery, and Shaping without changing the core session posture.
- Keep runtime awareness visible enough to avoid execution mistakes.

## Surface posture

- The conversation is dominant.
- Supporting context belongs beside the conversation rather than above it.
- Runtime/session state remains backend-owned.
- Planning artifacts remain Git-backed files under `.isagi/`.

## Core principles

- Discovery and Shaping are prompt-template modes over the same core brainstorming capability.
- UI may adapt side panels for Discovery or Shaping, but the model does not require separate agent types.
- Discovery proposes milestone direction in chat before writing files.
- Shaping proposes task chunks in chat before writing files.
- Artifact writes require user confirmation.
- Execution state should stay visible enough to prevent avoidable mistakes, but should not overtake the conversation.
- Changing execution root creates a new session instead of preserving the same session identity.

## Key boundaries

- Project momentum and artifact browsing belong to `docs/product/screens/project-detail-screen.md`.
- Compact task jump-in belongs to `docs/product/screens/task-detail-modal.md`.
- Artifact semantics belong to `docs/product/planning-artifacts.md`.
- Runtime behavior belongs to `docs/architecture/execution-model.md`.

## Canonical references

- `docs/product/mental-model.md`
- `docs/product/planning-artifacts.md`
- `docs/architecture/execution-model.md`
