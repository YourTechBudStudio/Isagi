# Agent Guidance Projections (AGENTS.md + TRIAGE.md)

**Last updated:** 2026-03-17

This document describes optional agent-readable guidance files that may complement the active project/task/session core.

## One-liner

Guidance projections can help agents work inside registered projects, and later may support the deferred Phase 2 spark-triage system without relying on custom parsing logic.

## Active posture (v0)

- Guidance projections are not part of the active task/session core.
- The main near-term use case is richer project-aware agent context through `AGENTS.md`.
- `TRIAGE.md` belongs to the deferred Phase 2 spark-triage system rather than the first MVP release.
- Exact projection strategy remains provisional in this docs pass.

## Terms (v1)

These docs use two related but distinct ideas:

- **Metadata-backed**: authoritative configuration lives in Isagi's metadata store (for example a local database) and is used by the product/runtime.
- **Git-backed**: the source of truth is content stored in a git working copy that the user intends to keep on disk or commit.

Guidance projections (`AGENTS.md`, `TRIAGE.md`) are agent-facing files. They are not themselves the authoritative configuration.

## Non-goals (v1)

- Deterministic parsing or schema enforcement of these files.
- Finalizing exact triager prompts or system messages in docs.
- Personalization/memory-driven triage behavior (future).

## Files and placement (v1)

Recommended files:

- `AGENTS.md` - general, always-on context for agents working inside a project repo.
- `TRIAGE.md` - Phase 2 spark-triage guidance when routing inbox items into project tasks.

Notes:

- `AGENTS.md` is intended to be applied automatically by OpenCode based on directory scoping.
- `TRIAGE.md` only matters once the deferred spark-triage workflow is implemented.
- Exact placement of triage guidance is still deferred.

## Writing goals

- Keep guidance **balanced**: useful, but not huge.
- Optimize for non-deterministic reasoning: provide **rubrics** and **examples**, not rigid pass/fail checks.
- Avoid attempting to encode runtime git mode or session start behavior here; executable rules should live in product metadata.

## Suggested `AGENTS.md` content (non-final)

`AGENTS.md` is for general agent work inside a project repo (not just triage).

Suggested sections:

- A short identity card (what this repo/project represents).
- In-scope / out-of-scope boundaries for work performed in this repo.
- Local conventions, architecture notes, or review expectations.
- Optional: a brief nomenclature pointer (where project/task/spark terms are defined).

## Suggested `TRIAGE.md` content (Phase 2, non-final)

`TRIAGE.md` is for Phase 2 spark-triage guidance when deciding whether a spark should become work in a project.

Suggested sections:

- Spark potential rubric:
  - direct fit (high confidence this belongs in the project)
  - evolvable/derivable fit (could belong after clarifying or splitting)
  - weak fit (likely belongs elsewhere or should remain a spark)
- Disqualifiers / anti-patterns (common false positives).
- Derivation paths (ways to evolve a spark into a better task candidate).
- Task-shaping rubric (when to create one task vs several tasks).
- Optional examples (encouraged, not mandatory).

Intentionally omitted (v1):

- Detailed "question scripts" per project. High-level questioning strategy is better handled by the triager prompt to avoid repetitive, noisy questioning.

## Large-project scalability

Some projects may contain many workstreams. In these cases:

- Prefer heuristics and archetypes.
- Avoid listing every possible task or backlog category in `AGENTS.md` or `TRIAGE.md`.

## Suggested metadata storage shape (non-final)

One approach is to store freeform Markdown as one column per suggested section, plus an overflow column.

Suggested characteristics:

- One Markdown blob per section (to keep generation predictable).
- `important_notes` (or similar) for project-specific nuances that do not fit the standard sections.

Exact columns are intentionally deferred to implementation.

## Generation and lifecycle (non-final)

Possible behaviors:

- Regenerate these files automatically when a project is created or updated.
- Provide a manual UI action to regenerate projections.
- If `TRIAGE.md` is introduced later, generate/regenerate it only when the Phase 2 spark-triage workflow exists.

Depending on repo intent and git backing, these files may be committed or treated as local projections.
