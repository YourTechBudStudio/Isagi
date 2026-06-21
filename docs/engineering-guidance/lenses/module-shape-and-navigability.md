# Module Shape And Navigability

## What This Lens Protects

This lens protects human-readable code flow. Isagi should use deep modules with narrow public surfaces, while organizing internals so reviewers can navigate behavior without spelunking through scattered fragments or giant mixed-purpose files.

## Review Questions

- Is the module deep enough to hide complexity from callers?
- Is the public surface narrow, intentional, and easy to find?
- Does `index.ts` expose the intended public interface for the module when a module boundary exists?
- Are internal files grouped by concept, responsibility, lifecycle, platform, or flow?
- Can a human reviewer follow the main path through the code?
- Is a large file still single-purpose and reviewable?
- When a deep service defines its whole method set inline in one Effect `Layer` body, is that body still followable, or should cohesive groups move into internal files behind the same surface?
- Would splitting a file clarify ownership or flow, or would it create shallow fragmentation?
- Are platform-specific variants discoverable through lowercase suffixes such as `.darwin.ts`, `.linux.ts`, or `.windows.ts` where needed?
- Are platform-neutral selectors or adapters separated from platform-specific implementation details?
- Do types, helpers, and implementation details live close to the behavior they support?

## Isagi-Specific Notes

- Prefer `index.ts` as the module's public entry point when a directory represents a module.
- Prefer grouped related files over scattered single-purpose fragments.
- Platform variants should use lowercase platform suffixes where practical.
- Deep modules are not huge files. They are modules with small public surfaces and well-organized internals.
- A deep Effect service can stay single-purpose yet grow a large inline `Layer` body that is hard to trace. Prefer extracting cohesive internal clusters (resolution, reconciliation, row mapping) into sibling files while keeping the public surface narrow.
- Avoid creating abstract interfaces merely to make code look architectural.

## Severity Mapping

### Blocker

- A module boundary makes ownership unclear across runtime, web, desktop, or contracts.
- A file or module becomes so broad that meaningful behavior review is impractical.
- Platform-specific behavior is mixed into shared logic in a way that risks incorrect behavior on other supported platforms.
- A public module surface exposes internals that callers start depending on.
- A refactor fragments lifecycle or state flow so much that correctness can no longer be followed.

### Concern

- Related files are scattered when grouping would make review and future change easier.
- A file is growing large because it contains multiple separable responsibilities.
- A service's inline `Layer` body has grown large enough that its method flow is hard to follow, even though the module stays single-purpose.
- A new abstraction is shallow ceremony rather than a useful boundary.
- Naming or grouping makes the intended code path hard to discover.
- A module lacks a clear public entry point even though callers treat it as a module.

### Nit

- A file suffix or name could better communicate its role.
- A helper or type could move closer to its only caller.
- A comment or local type would improve scanability.
- Imports or exports could be trimmed to make the public surface clearer.
