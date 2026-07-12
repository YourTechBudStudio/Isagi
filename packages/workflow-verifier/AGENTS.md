# Workflow Verifier

## What this is

The independently versioned public verifier and build-receipt contract for Isagi workflows.

## Rules

- `fixtures/minimal-workflow` is the canonical workflow scaffold shipped with `isagi-docs`.
- Changes to verification behavior, package compatibility, receipt format, or the scaffold must keep the workflow SDK, runtime loader, workflow documentation, and `apps/runtime/src/agent-sessions/harness/skill-content/workflows.md` synchronized.
- Keep SDK and verifier compatibility explicit and covered by tests.
- Do not bump this package for unrelated application releases.
