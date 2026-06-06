# 0001-state-ownership-and-active-context-restoration

status: accepted
date: 2026-06-05

## Decision

Isagi separates state ownership from persistence location and frontend tooling.

Runtime/server state in the web app should be read, cached, and mutated through React Query over the Effect runtime client. Frontend interaction state should stay in frontend-owned state such as local component state or Zustand.

`activeContext` is frontend-owned live workspace selection persisted by the runtime for restart restoration. The runtime may validate and store it, and workspace snapshots may return it as restoration data. It is not runtime operational scope.

Operational APIs must accept explicit targets such as project, worktree, command, agent-session, or surface identifiers. They must not infer their target from persisted `activeContext`.

Mutations should return the minimal result needed for the client to update cache or UI state. They should not return a full workspace snapshot by default.

## Current ownership map

| state | meaning_owner | persistence_host | frontend_mechanism |
|---|---|---|---|
| projects/worktrees | runtime/Git | runtime | server-state cache |
| add project result | runtime | runtime | mutation cache update |
| path suggestions | runtime | none | direct Effect call or server-state query when useful |
| activeContext/live worktree selection | frontend | runtime restoration state | frontend state + persistence sync |
| active surface | frontend | none for now | frontend state |
| drawer/command selection/zen | frontend | none for now | frontend state |
| toasts | frontend | none | frontend state |

## Active context mechanics

On startup, the frontend hydrates live selection from `workspace.activeContext` when no fresher frontend selection exists.

When the user selects a worktree, the frontend updates live selection immediately and persists the latest active context to the runtime. Persistence should be latest-wins; stale writes should not overwrite newer user intent.

If a selected worktree disappears, Isagi should fall back to that project's root checkout. If a project is unavailable, Isagi should show the missing-project recovery state rather than hiding the problem.

## Mutation direction

`POST /projects` should not reconcile unrelated projects. It can return the changed project slice plus the active context selected for restoration, allowing the frontend to update the workspace cache without fetching a full snapshot.

`PATCH /workspace/active-context` persists frontend selection for restoration and should return only an acknowledgement or minimal active-context confirmation.

## Consequences

- Runtime remains the owner of operational state and Git/worktree facts.
- Frontend selection can be optimistic without making the runtime state file an execution scope.
- Future command, agent, process, and session APIs must name targets explicitly.
- Cache invalidation is a tool, not a substitute for clear state ownership.
