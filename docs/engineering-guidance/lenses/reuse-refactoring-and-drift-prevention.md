# Reuse, Refactoring, And Drift Prevention

## What This Lens Protects

This lens protects Isagi from parallel implementations of the same behavior, visual pattern, lifecycle rule, or contract concept. Drift is expensive in a project with runtime orchestration, UI state, surfaces, commands, sessions, and attention signals.

Reuse is not automatic. Reuse should prevent drift without weakening boundaries, readability, or local reasoning.

## Review Questions

- Is this function, component, module, or behavior similar to an existing one?
- Does the similarity represent the same product behavior, lifecycle rule, visual pattern, or contract concept?
- Would reuse or consolidation reduce behavioral, visual, or logic drift?
- Did the change bypass an existing abstraction because that abstraction is wrong, or because it was inconvenient?
- Should the existing shared component/module be improved instead of creating a parallel path?
- Are there now two places that must be updated together?
- Is the same fixture, service stub, or test environment hand-rolled across multiple suites instead of built from a shared helper?
- Does shared code cross a boundary it should not cross?
- Does a refactor leave old and new patterns side by side without a cleanup path?
- Can callers be migrated to a cleaner internal interface instead of preserving both paths?

## Isagi-Specific Notes

- Reviewers should actively look for reuse opportunities. Do not wait for obvious copy-paste.
- Shared UI components should reduce visual and behavior drift while preserving Isagi's design language.
- Shared runtime helpers should clarify lifecycle and failure semantics, not hide important differences.
- Test support code drifts too. Duplicated service stubs, fixtures, and environment setup across suites should usually be consolidated into shared builders, so an interface change updates one place instead of many.
- Pre-MVP refactors should prefer clean internal interfaces and migrated callers over compatibility shims.
- Similarity alone is not enough. Reuse must still preserve local reasoning and package boundaries.

## Severity Mapping

### Blocker

- A change creates a parallel implementation of important behavior likely to diverge from an existing source.
- A change bypasses an established module, component, or interface in a way that undermines consistency.
- A compatibility shim or dual path is introduced where private callers can safely be migrated.
- Product-critical behavior is duplicated across runtime, client, or contracts without a clear source of truth.

### Concern

- Similar logic or components exist and reuse or consolidation should be considered.
- A new abstraction is too shallow, but the duplication risk is real.
- A refactor leaves old and new patterns side by side without a cleanup path.
- Shared code reduces drift but makes local reasoning noticeably harder.
- Naming differs across similar concepts in a way likely to confuse future changes.
- The same test fixture or service stub is hand-rolled across many suites, so an interface change must be repeated in many places.

### Nit

- A small helper could reuse an existing utility.
- Naming could better align similar concepts.
- A minor consolidation opportunity exists with low drift risk.
- A comment could explain why two similar paths intentionally remain separate.
