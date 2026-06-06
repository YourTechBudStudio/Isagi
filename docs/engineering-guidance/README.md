# Engineering Guidance

This guidance helps humans and coding agents keep Isagi maintainable as the product grows across Electron, React, runtime orchestration, Git/worktree state, process lifecycles, runtime API contracts, and user-facing recovery behavior.

Use it during implementation and review. It is a review aid, not a style manual.

## Reading Order

1. [`principles.md`](./principles.md) - the durable engineering principles.
2. [`how-to-use.md`](./how-to-use.md) - how coding and review agents should apply the guidance.
3. The relevant lens docs under [`lenses/`](./lenses/).

## Lenses

The lenses are equal-priority review tools. A change does not need to touch every lens equally, but reviewers should not treat any relevant lens as optional.

- [`boundaries-and-contracts.md`](./lenses/boundaries-and-contracts.md) - package ownership, source-of-truth boundaries, runtime API shape, error contracts, trust boundaries, and interface evolution.
- [`module-shape-and-navigability.md`](./lenses/module-shape-and-navigability.md) - deep modules, narrow public surfaces, file grouping, and human-readable flow.
- [`reuse-refactoring-and-drift-prevention.md`](./lenses/reuse-refactoring-and-drift-prevention.md) - shared behavior, refactoring pressure, and drift prevention.
- [`runtime-behavior-and-diagnostics.md`](./lenses/runtime-behavior-and-diagnostics.md) - operational work, Effect usage, lifecycle ownership, failure semantics, logging, and supportability.
- [`product-behavior-and-ux.md`](./lenses/product-behavior-and-ux.md) - honest product behavior, restoration, attention signals, and user-visible engineering quality.
- [`reviewability-and-verification.md`](./lenses/reviewability-and-verification.md) - verification depth, dependency justification, review evidence, and completed-work trust.

## Severity Ladder

Each lens defines its own `Blocker`, `Concern`, and `Nit` calibration.

- **Blocker** - material divergence from guidance; must fix before returning the change; triggers re-review after the fix.
- **Concern** - design, runtime, maintainability, supportability, or product gap with real consequence; fix directly when clear or surface to the user when it needs a tradeoff decision.
- **Nit** - marginal optional improvement; terminal and never a reason for re-review on its own.

## What This Guidance Does Not Police

- Formatting already handled by tooling.
- Arbitrary file-size limits.
- Personal naming preferences beyond clarity and navigability.
- Abstraction for its own sake.
- Effect wrappers around pure code just to make it look architectural.
- Exhaustive logging in every function.
- Speculative compatibility for private internals.
- Generic best-practice checklists not tied to Isagi's risks.
- Full API style guides, HTTP trivia, or endpoint naming rules beyond durable boundary and failure-semantics risks.
