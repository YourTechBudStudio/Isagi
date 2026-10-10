# Workflow SDK

## What this is

The independently versioned public TypeScript contract for authoring Isagi workflows.

## Rules

- Keep this package descriptive and free of runtime implementation concerns.
- Changes to exports, types, constructors, or `workflowContractVersion` must keep the workflow verifier, receipt compatibility, runtime consumers, canonical scaffold, workflow documentation, and `apps/runtime/src/harnesses/skill-content/workflows.md` synchronized.
- Do not bump this package for unrelated application releases.
