# State Flow, Causality, And Operational Cost

## What This Lens Protects

This lens protects predictable change. Once ownership is clear, state transitions should have understandable causes, bounded effects, and operational cost that matches the triggering action.

It exists to catch convenience-driven flows where an API, cache update, background task, or user action quietly does more than its caller can reason about.

Use this lens alongside the neighboring lenses:

- `boundaries-and-contracts.md` decides who owns a fact, API, source of truth, or trust boundary.
- This lens decides whether changes to that fact are caused by the right action, shaped narrowly, and paid for in the right place.
- `runtime-behavior-and-diagnostics.md` decides whether operational work has clear lifecycle, failure, cancellation, and diagnostic behavior.

## Review Questions

- Can a reviewer explain what caused each state transition?
- Does each mutation do one semantic thing, or does it also change adjacent state as a hidden side effect?
- Is the response from a mutation limited to what the caller needs for the immediate next step?
- Does a query or read path stay lightweight enough for callers to treat it as a read?
- Is broad discovery, reconciliation, cleanup, or recovery work attached to an explicit trigger or background lifecycle rather than hidden inside an unrelated action?
- Does cache mutation, invalidation, or refetching preserve one clear path for server state to enter the UI?
- Are optimistic updates reserved for interactions where responsiveness materially affects the user experience?
- Can stale async work, queued writes, polling, or timers overwrite fresher user intent?
- Is the cost of the operation visible from the API, function name, hook, or surrounding flow?
- Would the same behavior still make sense if the runtime becomes remote or slower?

## Isagi-Specific Notes

- Workspace snapshots should be cheap to fetch relative to reconciliation or discovery work. If fetching known state also refreshes external truth, that coupling should be deliberate and reviewable.
- Structural mutations that are rare can usually return a minimal result and let the client refetch server state, instead of constructing a second state-update path.
- High-frequency interaction state may justify optimistic updates, but optimistic behavior should not obscure ownership or allow stale persistence to win over newer selection.
- Background work should have a named lifecycle owner. Periodic reconciliation, polling, and repair loops should not appear as incidental side effects of ordinary UI actions.
- Cache invalidation is a coordination tool, not a substitute for a clear state-flow model.

## Severity Mapping

### Blocker

- A mutation or read path changes user-visible or durable state as a hidden side effect that contradicts the intended owner or caller expectation.
- Broad reconciliation, discovery, cleanup, or repair work is hidden inside a latency-sensitive or seemingly lightweight user action in a way that can block, mislead, or materially change product behavior.
- Two competing paths can write or derive the same important state, making freshness or user intent impossible to reason about.
- Stale async work can overwrite newer user intent for important selection, restoration, or operational targeting state.
- A mutation response or cache update creates a shadow source of truth for broad runtime state.

### Concern

- A flow is technically correct but combines multiple semantic actions in a way that makes future changes risky.
- Mutation responses return more data than the caller needs, encouraging broad cache surgery or duplicate snapshot logic.
- Reads and reconciliation are coupled without enough evidence that the cost and timing are acceptable.
- Optimistic behavior is used where the UX benefit is weak, increasing state complexity without clear payoff.
- Timers, polling, invalidation, or refetching are present but the intended freshness model is hard to explain.
- The operation cost is plausible, but not visible enough from names, API shape, or nearby code for reviewers to reason about it.

### Nit

- A function, hook, route, or mutation name could better communicate whether it reads, refreshes, reconciles, or mutates.
- A small comment would make an intentional state-flow or freshness tradeoff easier to review.
- A response includes a low-risk extra field that is not currently needed.
- A cache invalidation or refetch could be placed closer to the action that requires it.
