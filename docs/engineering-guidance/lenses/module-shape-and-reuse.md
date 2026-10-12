# Module Shape And Reuse

## What This Lens Protects

Code that humans can navigate and that does not drift. Isagi uses deep modules with narrow public surfaces, organizes internals so reviewers can follow behavior without spelunking, and avoids parallel implementations of the same behavior, visual pattern, lifecycle rule or contract concept. Reuse is not automatic: it must prevent drift without weakening boundaries, readability or local reasoning.

## Review Questions

Shape:

- Is the module deep enough to hide complexity, with a narrow, intentional public surface (its `index.ts` when it is a module)?
- Are internal files grouped by concept, responsibility, lifecycle, platform or flow, and can a reviewer follow the main path?
- Is a large file still single-purpose? Has a service body grown so large that cohesive groups should move into internal files behind the same surface?
- Would a split clarify ownership or flow, or only create shallow fragments?
- Are platform variants discoverable (lowercase suffixes such as `.darwin.ts`, `.linux.ts`) and kept apart from platform-neutral selectors?
- Do types and helpers live close to the behavior they support?
- Does a runtime file live in the module that owns the behavior, and does a cross-module dependency go through that module's public files and point down?

Reuse and drift:

- Is this function, component or behavior similar to an existing one, and is the similarity the same product behavior, lifecycle rule, visual pattern or contract concept?
- Did the change bypass an existing abstraction because it is wrong, or because it was inconvenient? Should it be improved instead?
- Are there now two places that must change together?
- Are fixtures, service fakes or test setup hand-rolled across suites instead of built from a shared helper?
- Does shared code cross a boundary it should not?
- Does a refactor leave old and new patterns side by side, where callers could simply be migrated?

## Isagi-Specific Notes

- Deep modules are not huge files: small public surfaces, well-organized internals.
- Do not create abstract interfaces just to look architectural.
- Look actively for reuse; do not wait for obvious copy-paste. Similarity alone is not enough: reuse must keep local reasoning and package boundaries intact.
- Shared UI components should reduce visual and behavior drift; shared runtime helpers should clarify lifecycle and failure semantics, not hide real differences.
- Test support drifts too. Consolidate repeated fakes and fixtures so an interface change updates one place.
- The runtime's `platform/` is not a miscellaneous folder: shared code goes there only when it has no product meaning and two or more consumers.

## Severity Mapping

### Blocker

- A module boundary makes ownership unclear across runtime, web, desktop or contracts.
- A file or module is so broad that meaningful review is impractical, or a refactor fragments lifecycle or state flow until correctness can't be followed.
- Platform-specific behavior is mixed into shared logic in a way that risks wrong behavior on another supported platform.
- A public surface exposes internals that callers start depending on.
- In the runtime: a new upward module dependency, a write to another module's table, or product rules in `platform/`.
- A change creates a parallel implementation of important behavior, or bypasses an established module, component or interface, so the two will diverge.
- A compatibility shim or dual path is added where private callers can be migrated.
- Product-critical behavior is duplicated across runtime, client or contracts without one source of truth.

### Concern

- Related files are scattered, or a file grows by holding several separable responsibilities.
- A service body has grown hard to follow even though the module is single-purpose.
- A new abstraction is shallow ceremony, or naming and grouping hide the intended code path.
- A module lacks a clear public entry point though callers treat it as one, or a deep import is "fixed" by widening `index.ts` with internals or a sub-folder barrel.
- Similar logic or components exist and consolidation should be considered.
- A refactor leaves old and new patterns side by side without a cleanup path.
- Shared code reduces drift but makes local reasoning noticeably harder.
- The same test fixture or fake is hand-rolled across many suites.

### Nit

- A file name or suffix could better communicate its role.
- A helper or type could move closer to its only caller.
- Imports or exports could be trimmed to sharpen the public surface.
- A small helper could reuse an existing utility, or naming could better align similar concepts.
- A comment could explain why two similar paths intentionally stay separate.
