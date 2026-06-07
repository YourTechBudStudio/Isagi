# 0002-mutation-results-state-refresh-and-operation-cost

status: accepted
date: 2026-06-06

## Decision

Mutation APIs should return the minimal operation result needed for the caller's immediate next step. Read/query APIs are the primary way clients obtain broad snapshots of server-owned state.

For rare structural mutations, the frontend should usually invalidate or refetch the relevant server-state query after the mutation succeeds instead of treating the mutation response as a second snapshot path.

Optimistic updates are reserved for interactions where immediate feedback materially improves the user experience, especially high-frequency selection or focus changes. Optimistic behavior must preserve freshness and must not let stale async work overwrite newer user intent.

Operationally expensive work such as broad discovery, reconciliation, cleanup, or repair should be attached to an explicit request or a named background lifecycle. It should not be hidden inside ordinary reads or unrelated user-triggered mutations.

## Consequences

- Mutation responses stay small and easier for clients to handle.
- Server-state snapshots have one primary entry path in the frontend cache.
- Rare actions can favor correctness and clear refresh behavior over optimistic cache surgery.
- High-frequency interactions can still be snappy when the product experience justifies the added state-flow complexity.
- Reconciliation and discovery work remain reviewable as operational behavior with visible cost and lifecycle.

## Notes

This ADR describes the default state-flow posture. A mutation may return richer data when that data is the direct result of the operation and the caller needs it immediately, but broad snapshots or unrelated derived state require an explicit reason.
