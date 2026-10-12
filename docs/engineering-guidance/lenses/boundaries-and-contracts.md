# Boundaries And Contracts

## What This Lens Protects

Package ownership, sources of truth, runtime API clarity, trust boundaries and clean interface evolution. Isagi's pieces must stay distinct: the Electron shell, the React web app, the local-or-remote runtime, Git/worktree truth, process and session lifecycles, and the shared API contracts.

This lens decides who owns a fact, behavior, API or trust boundary. Whether a change to that fact has the right cause, scope and cost belongs to `state-flow-and-operational-cost.md`.

## Review Questions

- Does the change keep the intended owner of the behavior, and does each durable or user-visible fact have one clear owner?
- Is persistence, caching or frontend state being mistaken for ownership?
- Could a persisted or cached value become hidden input to unrelated operational behavior?
- Do state-changing APIs name their target and source of truth explicitly enough for client and runtime to reason about the transition?
- Does the runtime still own operational state and lifecycle facts, and is Git still the source of truth for repository and worktree facts where practical?
- Does the web app stay free of Electron assumptions, and desktop focused on native shell, windows and runtime bootstrapping?
- Do shared contracts describe request, response and error wire shapes without leaking implementation?
- Do runtime routes use the versioned API surface (`/api/v1`) and shared contracts?
- Is each expected failure that crosses the runtime/client boundary a stable contract error (code, status, structured `data`, a reason where nuance matters) on every surface that reaches the user, including streams and sockets, not only HTTP envelopes?
- Is the mapping from runtime failures to contract errors explicit and easy to audit?
- Does the web map those codes to its own copy, instead of showing a runtime- or contract-authored message as the line the user reads?
- Are interfaces explicit where behavior crosses package, process, platform, integration, persistence or public API boundaries?
- Is compatibility kept only where a real user, data, API, integration or deployment boundary needs it?
- Does the change widen filesystem, command, process or privilege exposure in a way review should see?

## Isagi-Specific Notes

- `apps/runtime` owns Git/worktree operations, processes and PTYs, agent session lifecycle, runtime state, persistence and future remote execution. `apps/web` owns the React app. `apps/desktop` owns Electron lifecycle, windows, preload and runtime bootstrapping. `packages/contracts` is implementation-free: serializable schemas and wire types only.
- Runtime HTTP APIs are explicit at the boundary: routes, methods, request decoding, response encoding and error envelopes are reviewable where they are registered.
- Runtime returns facts; the web writes copy. A runtime message is diagnostic, not user copy. The voiced line a person reads is always web-owned and chosen by code and reason. The web may also show diagnostic detail (a raw message, command output, `code`, `requestId`) when it helps debugging, but clearly framed as diagnostic.
- A failure channel that can only describe itself with a human-readable string forces product voice behind the boundary.

## Severity Mapping

### Blocker

- UI or client code becomes the source of truth for runtime facts that belong to the runtime or Git.
- Electron-specific assumptions leak into the web package.
- Contracts carry implementation concerns, or fail to model meaningful client/runtime behavior.
- A runtime route bypasses shared contracts, the versioned API surface or explicit error modeling.
- A user-facing failure crosses the runtime/client boundary without a stable code the client can map, or the web renders a runtime or contract message as the voiced line.
- Runtime, contracts or desktop import web copy, making product voice a cross-boundary dependency.
- A persisted, cached or frontend-owned value becomes hidden input to runtime behavior that should take an explicit target.
- Ownership across runtime, desktop, web and contracts becomes materially unclear, or future remote-runtime separation gets materially harder without an explicit tradeoff.
- Command execution, filesystem access, process control or privilege exposure grows without deliberate handling.

### Concern

- Ownership is mostly clear but the boundary is getting harder to explain.
- Persistence, caching or frontend state obscures who owns an important fact.
- An interface is implicit where an explicit one would improve safety or reviewability.
- A contract works but weakly communicates behavior, failure semantics or client obligations.
- API errors are too generic for clients to tell apart validation, domain, internal or degraded-runtime cases that matter, or their mapping is scattered and hard to audit.
- Diagnostic detail reaches the user without being framed as diagnostic.
- Compatibility is kept speculatively, without a real external dependency.
- Trust boundary or dependency implications are not surfaced.

### Nit

- A boundary, route, export or type name could be clearer.
- A public surface exports more than callers need, with low current risk.
- A short note would make an intentional boundary tradeoff easier to review.
