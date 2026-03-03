# Agent Guidance Projections (AGENTS.md + TRIAGE.md)

**Last updated:** 2026-03-03

This document describes how Isagi projects metadata-backed area configuration into agent-readable files.

## One-liner

Areas can expose lightweight, human-authored or generated guidance files (`AGENTS.md`, `TRIAGE.md`) so agent sessions can make better non-deterministic decisions (especially during spark triage) without relying on custom parsing logic.

## Terms (v1)

These docs use two related but distinct ideas:

- **Metadata-backed**: authoritative configuration lives in Isagi's metadata store (for example a local database) and is used by the product/runtime.
- **Git-backed**: the source of truth is content stored in a git working copy (for example resources on disk with reviewable history).

Guidance projections (`AGENTS.md`, `TRIAGE.md`) are agent-facing files. They are not themselves the authoritative configuration.

When this doc mentions whether guidance can be committed, "git-backed" means the relevant area workspace root is inside a git repo that the user intends to commit to (often true for `area_monorepo`, not necessarily true for `resource_repos`).

## Non-goals (v1)

- Deterministic parsing or schema enforcement of these files.
- Finalizing exact triager prompts or system messages in docs.
- Personalization/memory-driven triage behavior (future).

## Files and placement (v1)

Recommended area-root files:

- `AGENTS.md` - general, always-on context for agents working inside the area directory.
- `TRIAGE.md` - triager-specific guidance for routing/qualifying sparks within the area.

Notes:

- `AGENTS.md` is intended to be applied automatically by OpenCode based on directory scoping.
- The triager prompt (automatic user message that starts triage) should explicitly instruct reading the relevant area-level `TRIAGE.md`.
- Project-level `AGENTS.md` files may be introduced later, but are intentionally not required for v1.

## Writing goals

- Keep guidance **balanced**: useful, but not huge.
- Optimize for non-deterministic reasoning: provide **rubrics** and **examples**, not rigid pass/fail checks.
- Avoid attempting to encode start/command execution behavior here; executable command templates should live in metadata (not these files).

## Suggested `AGENTS.md` content (non-final)

`AGENTS.md` is for general agent work inside an area (not just triage).

Suggested sections:

- A short identity card (what this area represents; optional human-readable name).
- In-scope / out-of-scope boundaries for work performed in this area.
- Project archetypes (what kinds of projects typically exist in the area) rather than enumerating all projects.
- Optional: a brief nomenclature pointer (where area/project/task/spark terms are defined).

## Suggested `TRIAGE.md` content (non-final)

`TRIAGE.md` is for spark triage guidance inside an area.

Suggested sections:

- Spark potential rubric:
  - direct fit (high confidence this belongs here)
  - evolvable/derivable fit (could belong here after clarifying or splitting)
  - weak fit (likely belongs elsewhere)
- Disqualifiers / anti-patterns (common false positives).
- Derivation paths (ways to evolve a spark into a better candidate for this area).
- Project vs task rubric (when to propose a new project vs tasks inside existing projects).
- Optional examples (encouraged, not mandatory).

Intentionally omitted (v1):

- Detailed “question scripts” per area. High-level questioning strategy is better handled by the triager prompt to avoid repetitive, noisy questioning across areas.

## Large-area scalability

Some areas may contain many projects. In these cases:

- Prefer project archetypes and decision heuristics.
- Avoid listing every project in `AGENTS.md` or `TRIAGE.md`.

## Suggested metadata storage shape (non-final)

One approach is to store freeform Markdown as one column per suggested section, plus an overflow column.

Suggested characteristics:

- One Markdown blob per section (to keep generation predictable).
- `important_notes` (or similar) for area-specific nuances that do not fit the standard sections.

Exact columns are intentionally deferred to implementation.

## Generation and lifecycle (non-final)

Possible behaviors:

- Regenerate these files automatically when an area is created or updated.
- Provide a manual UI action to regenerate projections.

Depending on area storage mode and git backing, these files may be committed to a repo or treated as local projections.
