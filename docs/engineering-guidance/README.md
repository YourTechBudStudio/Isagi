# Engineering Guidance

This guidance helps humans and coding agents keep Isagi maintainable as it grows across Electron, React, runtime orchestration, Git/worktree state, process lifecycles, API contracts and user-facing recovery. Use it while implementing and reviewing. It is a review aid, not a style manual.

## Reading Order

1. [`principles.md`](./principles.md) - the durable engineering principles.
2. [`how-to-use.md`](./how-to-use.md) - how coding and review agents apply the guidance, the severity ladder, and how to act on review output.
3. The relevant lenses under [`lenses/`](./lenses/).

Decisions live in ADRs ([`../adrs/README.md`](../adrs/README.md)); how Isagi uses Effect is ADR 0012.

## Lenses

The lenses are equal-priority review tools. A change does not touch every lens equally, but no relevant lens is optional.

- [`boundaries-and-contracts.md`](./lenses/boundaries-and-contracts.md) - ownership, sources of truth, runtime API and error contracts, trust boundaries.
- [`state-flow-and-operational-cost.md`](./lenses/state-flow-and-operational-cost.md) - what causes each state change, mutation shape, cache flow, hidden side effects, operation cost.
- [`module-shape-and-reuse.md`](./lenses/module-shape-and-reuse.md) - deep modules, narrow surfaces, navigable internals, reuse and drift.
- [`runtime-behavior-and-diagnostics.md`](./lenses/runtime-behavior-and-diagnostics.md) - lifecycle, failure semantics, cancellation, resource ownership, diagnostics.
- [`product-ux-and-design.md`](./lenses/product-ux-and-design.md) - honest product behavior, restoration, attention, and visual and voice fidelity.
- [`reviewability-and-verification.md`](./lenses/reviewability-and-verification.md) - verification depth, dependency justification, review evidence.

## What This Guidance Does Not Police

- Formatting, or anything else tooling already enforces.
- Arbitrary file-size limits or personal naming preferences.
- Abstraction for its own sake, or simplicity preferences not tied to ownership, state flow, cost, navigability or reviewability.
- Effect wrappers around pure code, or a service for every helper.
- Exhaustive logging in every function.
- Speculative compatibility for private internals.
- Generic best-practice checklists, API style guides or HTTP trivia not tied to Isagi's risks.
