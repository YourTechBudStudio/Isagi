# Boundaries And Contracts

## What This Lens Protects

This lens protects package ownership, source-of-truth boundaries, contract clarity, and clean interface evolution.

Isagi has several moving pieces that must stay distinct: Electron shell, React web app, local-or-remote runtime, Git/worktree truth, process/session lifecycles, and shared oRPC contracts.

## Review Questions

- Does the change preserve the intended owner of the behavior?
- Is the runtime still the owner of operational state and lifecycle facts?
- Does the web app remain free of Electron-specific assumptions?
- Does desktop code stay focused on native shell, windowing, and runtime bootstrapping concerns?
- Do shared contracts describe behavior without leaking implementation details?
- Is Git still treated as source of truth for repository and worktree facts where practical?
- Are interfaces explicit where behavior crosses package, process, platform, integration, or persistence boundaries?
- Is compatibility preserved only where a real user, data, API, integration, or deployment boundary requires it?
- Could callers be safely migrated instead of adding a compatibility shim?
- Does the change expand filesystem, command, process, or privilege exposure in a way that should be visible in review?

## Isagi-Specific Notes

- `apps/runtime` owns Git/worktree operations, process and PTY management, agent session lifecycle, runtime state, persistence direction, and future remote execution paths.
- `apps/web` owns the React app and should not depend on Electron-specific behavior.
- `apps/desktop` owns Electron lifecycle, windows, preload boundaries, and runtime bootstrapping.
- `packages/contracts` should stay implementation-free.
- Pre-MVP internal interfaces should evolve cleanly. Avoid internal compatibility theater when callers can be migrated safely.

## Severity Mapping

### Blocker

- UI/client code becomes the source of truth for runtime facts that should live in runtime or Git.
- Electron-specific assumptions leak into the web package.
- Contracts include implementation concerns or fail to model meaningful client/runtime behavior explicitly.
- Runtime, desktop, web, and contracts ownership becomes materially unclear.
- A change makes future remote-runtime separation materially harder without an explicit tradeoff.
- Command execution, filesystem access, process control, or privilege exposure expands without deliberate handling.
- A compatibility shim or dual path is introduced for private internals where callers can safely be migrated.

### Concern

- Ownership is mostly clear, but the boundary is becoming harder to explain or maintain.
- An interface is implicit where an explicit boundary would improve safety or reviewability.
- A contract shape is technically usable but weakly communicates behavior or failure semantics.
- Compatibility is preserved speculatively without a clear external dependency.
- Trust boundary or dependency implications are lightly considered but not well surfaced.

### Nit

- A boundary name, export, or type could be clearer.
- A public surface exports more than callers need, with low current risk.
- A short note would make an intentional boundary tradeoff easier to review.
