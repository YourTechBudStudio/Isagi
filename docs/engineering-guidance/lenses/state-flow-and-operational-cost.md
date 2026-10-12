# State Flow And Operational Cost

## What This Lens Protects

Predictable change. Once ownership is clear, every state transition has an understandable cause, bounded effects, and a cost that matches the action that triggered it. This lens catches convenience-driven flows where an API, cache update, background task or user action quietly does more than its caller can reason about.

`boundaries-and-contracts.md` decides who owns a fact; this lens decides whether changes to it have the right cause, shape and cost; `runtime-behavior-and-diagnostics.md` reviews the lifecycle and failure behavior of the work itself.

## Review Questions

- Can a reviewer explain what caused each state transition?
- Does each mutation do one semantic thing, or does it also change adjacent state as a hidden side effect?
- Is a mutation's response limited to what the caller needs for its next step?
- Does a read stay light enough for callers to treat it as a read?
- Is broad discovery, reconciliation, cleanup or recovery tied to an explicit trigger or a named background lifecycle, not hidden inside an unrelated action?
- Do runtime-owned facts enter the UI through one path, with invalidation or refetching that refreshes what the action changed and nothing more?
- Are optimistic updates reserved for interactions where responsiveness really matters?
- Can stale async work, queued writes, polling or timers overwrite newer user intent?
- Is the cost of an operation visible from its API, name or surrounding flow?
- Would the behavior still make sense if the runtime were remote or slower?

## Isagi-Specific Notes

- Workspace snapshots are cheap relative to reconciliation or discovery. If fetching known state also refreshes external truth, that coupling is deliberate and reviewable.
- Rare structural mutations usually return a minimal result and let the client refetch, instead of building a second state-update path.
- In the web app, runtime-owned facts enter the UI only through query atoms. A different freshness need is a policy override on that query, not a second fetch path or a hand-written timer.
- Invalidation names exactly the keys an action changed. A broader key (a prefix, a catch-all) is hidden coupling.
- Optimistic projections stay out of the server-state cache: they sit on top of the latest read, so an older read cannot overwrite a newer move and a failure rolls back only its own change. Every stale-write guard (revision, latest-wins, per-key sequence) says which write wins.
- Background work has a named lifecycle owner. Polling, reconciliation and repair loops are never incidental side effects of ordinary UI actions.

## Severity Mapping

### Blocker

- A mutation or read changes user-visible or durable state as a hidden side effect that contradicts its owner or its caller's expectation.
- Broad reconciliation, discovery, cleanup or repair hides inside a latency-sensitive or seemingly light action in a way that can block, mislead or change product behavior.
- Two competing paths write or derive the same important state, so freshness or user intent can't be reasoned about.
- Stale async work can overwrite newer user intent for selection, restoration or operational targeting.
- A mutation response or cache update becomes a shadow source of truth for broad runtime state.

### Concern

- A flow is correct but bundles several semantic actions, making future change risky.
- A mutation returns more than its caller needs, inviting broad cache surgery or duplicate snapshot logic.
- Reads and reconciliation are coupled without evidence that the cost and timing are acceptable.
- Optimistic behavior adds state complexity for a weak UX benefit.
- Timers, polling, invalidation or refetching exist but the intended freshness model is hard to explain.
- The cost is plausible but not visible enough from names, API shape or nearby code.

### Nit

- A name could better say whether it reads, refreshes, reconciles or mutates.
- A short comment would make an intentional freshness tradeoff easier to review.
- A response carries a low-risk unused field.
- An invalidation or refetch could sit closer to the action that needs it.
