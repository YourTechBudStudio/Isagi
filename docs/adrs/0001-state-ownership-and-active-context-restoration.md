# 0001-state-ownership-and-active-context-restoration

status: accepted
date: 2026-06-05

## Decision

Isagi separates state ownership from persistence location and frontend tooling.

Runtime/server state in the web app should be read, cached, and mutated through React Query over the Effect runtime client. Frontend interaction state should stay in frontend-owned state such as local component state or Zustand.

`activeContext` is frontend-owned live workspace selection persisted by the runtime for restart restoration. The runtime may validate and store it through dedicated active-context persistence APIs. It is not part of the workspace snapshot and is not itself runtime operational scope.

When a runtime API accepts a state transition, the runtime may publish a runtime-internal domain event describing that transition. Event publication does not transfer ownership of the underlying state fact: subscribers own their own operational decisions, and frontend-owned state remains frontend-owned even when its accepted transition is observable inside the runtime.

Operational APIs must accept explicit targets such as project, worktree, command, agent-session, or surface identifiers. They must not infer their target from persisted `activeContext`. Runtime-internal event subscribers may use explicit target identifiers carried by an accepted transition event, such as previous/current worktree identifiers, because the event payload is the operational target rather than ambient persisted state.

Mutations should return the minimal result needed for the client to update cache or UI state. They should not return a full workspace snapshot by default.

## Current ownership map

| state                                 | meaning_owner | persistence_host          | frontend_mechanism                                   |
| ------------------------------------- | ------------- | ------------------------- | ---------------------------------------------------- |
| projects/worktrees                    | runtime/Git   | runtime                   | server-state cache                                   |
| add project result                    | runtime       | runtime                   | mutation result + workspace query invalidation       |
| path suggestions                      | runtime       | none                      | direct Effect call or server-state query when useful |
| activeContext/live worktree selection | frontend      | runtime restoration state | frontend state + active-context persistence sync     |
| missing-project selection             | frontend      | none                      | transient frontend state                             |
| active surface                        | frontend      | none for now              | frontend state                                       |
| drawer/command selection/zen          | frontend      | none for now              | frontend state                                       |
| toasts                                | frontend      | none                      | frontend state                                       |

## Active context mechanics

On startup, the frontend hydrates live selection by combining `GET /workspace` project/worktree facts with `GET /workspace/active-context` restoration data when no fresher frontend selection exists. If restoration names a project, the frontend may explicitly request project-scoped reconciliation after hydration so stale worktree facts can be corrected without making `GET /workspace` expensive.

`GET /workspace` returns the workspace read model for projects and worktrees. It does not return `activeContext`, select defaults, normalize restoration state, reconcile Git state, or write persistence.

`GET /workspace/active-context` returns the persisted restoration context. If the state file is missing or malformed, runtime state-file recovery may reset it to empty and log a runtime diagnostic.

`PUT /workspace/active-context` replaces the persisted context. It carries a client-generated monotonic revision so stale writes cannot overwrite newer user intent. It may perform quick database validation: an empty context is allowed; otherwise the project and worktree must exist, the project must be present, and the worktree must belong to the project. It must not inspect Git, derive fallback, select a root checkout, or persist anything other than the exact accepted value.

When the user selects a worktree, the frontend updates live selection immediately and persists the latest active context to the runtime. Persistence should be latest-wins; stale writes should not overwrite newer user intent.

As one application of runtime-internal transition events, if a newer active-context write is accepted and the active worktree changes, the runtime may publish `worktree_activation_change` with `{ previousWorktreeId, nextWorktreeId, cause: 'active_context_changed' }`.

Missing-project selection is transient frontend recovery UI state. It should not be newly persisted as `activeContext`. If a selected worktree disappears, the frontend may fall back to that project's root checkout. If a project is unavailable, the frontend should show the missing-project recovery state rather than hiding the problem.

## Mutation and reconciliation direction

`POST /projects` should validate/register the target project, run reconciliation scoped to that project so the project has useful worktree facts, and return a minimal result such as `{ projectId, alreadyExisted }`. It must not set `activeContext` or return a workspace snapshot.

Broad workspace reconciliation is explicit operational work. `POST /workspace/reconcile` may reconcile all projects or a caller-specified project and return structured reconciliation findings such as `project_missing`, `project_restored`, `worktree_added`, or `worktree_missing`. Findings summarize runtime-owned discrepancies; they are not a durable notices/event-log system.

Project relocation and project deletion are future explicit project-management APIs. Missing-project recovery UI should not be implemented by implicit active-context or reconciliation side effects.

## Consequences

- Runtime remains the owner of operational state and Git/worktree facts.
- Frontend selection can be optimistic without making the runtime state file a general execution scope.
- Accepted state transitions may become runtime-internal domain events, but event payloads must carry explicit operational targets and subscribers own their own operational decisions.
- Workspace snapshots have one purpose: known runtime project/worktree facts for the UI read model.
- Future command, agent, process, and session APIs must name targets explicitly.
- Cache invalidation is a coordination tool, not a substitute for clear state ownership.
