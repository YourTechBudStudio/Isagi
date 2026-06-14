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
- [`state-flow-causality-and-operational-cost.md`](./lenses/state-flow-causality-and-operational-cost.md) - explicit state transitions, mutation shape, cache flow, hidden side effects, and operation cost.
- [`module-shape-and-navigability.md`](./lenses/module-shape-and-navigability.md) - deep modules, narrow public surfaces, file grouping, and human-readable flow.
- [`reuse-refactoring-and-drift-prevention.md`](./lenses/reuse-refactoring-and-drift-prevention.md) - shared behavior, refactoring pressure, and drift prevention.
- [`runtime-behavior-and-diagnostics.md`](./lenses/runtime-behavior-and-diagnostics.md) - operational work, Effect usage, services/layers, tagged failures, lifecycle ownership, diagnostics, and supportability.
- [`product-behavior-and-ux.md`](./lenses/product-behavior-and-ux.md) - honest product behavior, restoration, attention signals, and user-visible engineering quality.
- [`design-fidelity-and-voice.md`](./lenses/design-fidelity-and-voice.md) - visual and voice adherence to Isagi's design language on user-facing surfaces, reviewed against the `design-system` skill.
- [`reviewability-and-verification.md`](./lenses/reviewability-and-verification.md) - verification depth, dependency justification, review evidence, and completed-work trust.

## Reviewer Output

The reviewer returns two distinct kinds of output. See [`how-to-use.md`](./how-to-use.md) for how the primary agent should consume each.

- **Severity findings** - defects on the ladder below.
- **`Architectural Reflection` (Step-Back)** - a proposal that a different solution shape would serve the goal better. It sits outside the ladder, is weighed as a decision rather than applied as a fix, and never triggers a re-review.

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
- Subjective simplicity preferences not tied to ownership, state flow, operational cost, navigability, or reviewability.
- Effect wrappers around pure code just to make it look architectural.
- Branding every primitive or turning every helper into a service.
- Exhaustive logging in every function.
- Speculative compatibility for private internals.
- Generic best-practice checklists not tied to Isagi's risks.
- Full API style guides, HTTP trivia, or endpoint naming rules beyond durable boundary and failure-semantics risks.
