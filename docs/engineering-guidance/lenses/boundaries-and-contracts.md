# Boundaries And Contracts

## What This Lens Protects

This lens protects package ownership, source-of-truth boundaries, runtime API clarity, trust boundaries, and clean interface evolution.

Isagi has several moving pieces that must stay distinct: Electron shell, React web app, local-or-remote runtime, Git/worktree truth, process/session lifecycles, and shared runtime API contracts.

This lens decides who owns a fact, behavior, API, source of truth, or trust boundary. Once ownership is clear, use `state-flow-causality-and-operational-cost.md` to judge whether the transition is caused by the right action and carries appropriate scope and cost.

## Review Questions

- Does the change preserve the intended owner of the behavior?
- Is each durable or user-visible state fact owned by a clear package, process, or product concept?
- Is persistence, caching, or frontend state tooling being mistaken for ownership?
- Could a persisted or cached value become hidden input to unrelated operational behavior?
- Do state-changing APIs make the target and source of truth explicit enough for both clients and runtimes to reason about the transition?
- Is the runtime still the owner of operational state and lifecycle facts?
- Does the web app remain free of Electron-specific assumptions?
- Does desktop code stay focused on native shell, windowing, and runtime bootstrapping concerns?
- Do shared contracts describe request, response, and error wire shapes without leaking implementation details?
- Do runtime API routes that cross the client/runtime boundary use the agreed versioned API surface, currently `/api/v1`?
- Are API errors modeled as stable client-facing contract concepts rather than leaked domain, framework, or runtime implementation errors?
- Does the contract make success and failure semantics understandable enough for clients to handle them deliberately?
- Is Git still treated as source of truth for repository and worktree facts where practical?
- Are interfaces explicit where behavior crosses package, process, platform, integration, persistence, or public API boundaries?
- Is compatibility preserved only where a real user, data, API, integration, or deployment boundary requires it?
- Could callers be safely migrated instead of adding a compatibility shim?
- Does the change expand filesystem, command, process, or privilege exposure in a way that should be visible in review?

## Isagi-Specific Notes

- `apps/runtime` owns Git/worktree operations, process and PTY management, agent session lifecycle, runtime state, persistence direction, and future remote execution paths.
- `apps/web` owns the React app and should not depend on Electron-specific behavior.
- `apps/desktop` owns Electron lifecycle, windows, preload boundaries, and runtime bootstrapping.
- `packages/contracts` should stay implementation-free: it may describe serializable API schemas and wire types, but not runtime services, layers, domain internals, fibers, or operational dependencies.
- Runtime HTTP APIs should be explicit rather than hidden behind framework dispatch: routes, methods, request decoding, response encoding, and error envelopes should be reviewable at the boundary.
- Runtime/client API contracts should use versioned routes, schema-backed success and error envelopes, `camelCase` field names, and `snake_case` literal error codes/reasons. This lens owns error shape, codes, and envelopes; the voice of any user-facing message string those errors carry is reviewed by `design-fidelity-and-voice.md`.
- Pre-MVP internal interfaces should evolve cleanly. Avoid internal compatibility theater when callers can be migrated safely.

## Severity Mapping

### Blocker

- UI/client code becomes the source of truth for runtime facts that should live in runtime or Git.
- Electron-specific assumptions leak into the web package.
- Contracts include implementation concerns or fail to model meaningful client/runtime behavior explicitly.
- A runtime API route that crosses the client/runtime boundary bypasses shared contracts, the versioned API surface, or explicit error modeling.
- Runtime, desktop, web, and contracts ownership becomes materially unclear.
- A persisted, cached, or frontend-owned state value becomes hidden input to operational runtime behavior that should accept an explicit target.
- A change makes future remote-runtime separation materially harder without an explicit tradeoff.
- Command execution, filesystem access, process control, or privilege exposure expands without deliberate handling.
- A compatibility shim or dual path is introduced for private internals where callers can safely be migrated.

### Concern

- Ownership is mostly clear, but the boundary is becoming harder to explain or maintain.
- Persistence, caching, or frontend state tooling obscures who owns an important state fact.
- An interface is implicit where an explicit boundary would improve safety or reviewability.
- A contract shape is technically usable but weakly communicates behavior, failure semantics, or client obligations.
- API error handling exists but is too generic for clients to distinguish validation, domain, internal, or degraded-runtime cases that matter.
- Compatibility is preserved speculatively without a clear external dependency.
- Trust boundary or dependency implications are lightly considered but not well surfaced.

### Nit

- A boundary name, route name, export, or type could be clearer.
- A public surface exports more than callers need, with low current risk.
- A short note would make an intentional boundary tradeoff easier to review.
