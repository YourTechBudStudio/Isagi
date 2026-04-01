# System Architecture

**Last updated:** 2026-03-31

This document defines the zoomed-out system architecture for Isagi.

It owns component boundaries, deployment modes, runtime ownership, harness placement, and trust assumptions. It does not redefine the product model, task semantics, or detailed execution mechanics that already belong to other docs.

## Architectural goals

- Make Isagi the primary user-facing interface for starting, resuming, and managing agent work.
- Keep the API backend as the system authority for runtime state and execution.
- Preserve one domain model across local and remote deployment modes.
- Support multiple agent harnesses behind a stable Isagi contract, starting with OpenCode.
- Stay desktop-first and single-user in the active MVP.

## System components

### Desktop shell

The desktop shell packages the Isagi UI and manages desktop-specific concerns.

Responsibilities:

- windowing and app lifecycle
- local backend startup and supervision in local mode
- backend connection configuration
- desktop packaging and distribution

The desktop shell is a client, not a second backend.

### Web UI

The web UI is the main Isagi product surface.

Responsibilities:

- render project, task, and session surfaces
- consume Isagi API responses and Isagi event streams
- present session controls, task controls, and execution visibility

The web UI remains independently runnable for development and can also be packaged inside the desktop shell.

### API backend

The API backend is the system authority.

Responsibilities:

- persist projects, tasks, sessions, and runtime metadata
- own repo registration and backend-visible repo paths
- own execution roots, managed worktrees, and git operations
- orchestrate harness runtimes and session lifecycle
- normalize runtime events into Isagi's event model

The backend is independently runnable and is the same logical system in local and remote modes.

### Internal harness adapters

Harness adapters live inside the API backend.

Responsibilities:

- translate Isagi session operations into harness-specific operations
- translate harness responses and events into Isagi-owned runtime concepts
- hide harness-specific API details from the rest of Isagi

Adapters are internal backend modules, not separate processes.

### External agent harness runtimes

Agent harnesses such as OpenCode and Claude Code remain external runtimes.

Responsibilities:

- run the underlying agent loop
- manage harness-native session history and execution
- expose harness-specific APIs or process interfaces that the backend integrates with

Isagi treats these harnesses as directory-scoped runtimes. The backend lazily starts or reconnects to a harness runtime for a given execution directory as needed.

## Deployment modes

### Local mode

In local mode:

- the desktop shell starts the API backend as a companion process
- repos and worktrees live on the local machine visible to that backend
- auth may be disabled
- when auth is disabled, the backend must remain loopback-bound only

### Remote mode

In remote mode:

- the desktop shell connects to a separately hosted API backend
- repos and worktrees live on the filesystem visible to that remote backend
- the system remains single-user
- a bearer API key grants full authority over the backend

Transport security is outside Isagi's scope. Remote deployments are expected to sit behind user-controlled infrastructure such as a reverse proxy with TLS termination when accessed over a network.

## Runtime ownership model

- The backend owns projects, tasks, sessions, repos, worktrees, git state observation, and persisted runtime metadata.
- The desktop shell and web UI do not directly mutate repo or worktree state for core workflows.
- A project points at an existing git repo path visible to the active backend.
- Sessions are the execution surfaces where agent work happens, but the backend remains the source of truth for session records and runtime bindings.
- Session types may add Isagi-specific behavior around the shared lifecycle, but that layered behavior does not change the core session model.

## Core architectural invariants

1. **The API backend is the system authority.**
2. **The desktop shell is a client shell, not a second backend.**
3. **Local and remote modes share the same domain model even when operational concerns differ.**
4. **Each Isagi session maps 1:1 to exactly one harness session.**
5. **Each session is bound to one execution directory for its lifetime.**
6. **Changing execution directory closes the current session and creates a new session instead of rebinding the same session.**
7. **Harness choice is fixed for the life of a session.** Model choice may change within that harness only if the harness supports it.
8. **The backend owns the canonical runtime contract exposed to the UI.**
9. **Harnesses are the default source of truth for full transcript history.** Isagi may store projections or cache layers later if needed.

## Harness integration model

- Isagi's core runtime model is inspired by leading agent harnesses that already support directory-bound session execution.
- OpenCode is the first supported harness, not the permanent hardcoded engine of the architecture.
- Additional harnesses should fit the same broad assumptions around directory-bound execution, lazily managed directory-scoped runtimes, resumable sessions, and backend-controlled runtime ownership.
- Harness-specific capabilities stay behind adapter boundaries.
- The backend should not leak harness-specific identifiers or event shapes into primary UI contracts unless needed for diagnostics.

## Event and transcript ownership model

- The UI is powered by Isagi-native events rather than raw harness events.
- The backend may capture raw harness events for debugging, logging, and diagnostics.
- Harness-native transcript persistence is preferred when the harness already supports durable session history and restart-safe resume.
- Isagi may later store lightweight projections, summaries, or cache layers without taking ownership of full transcripts by default.

## Trust model

- The active MVP is single-user in both local and remote modes.
- Local mode may run without auth only when the backend is loopback-bound.
- Local deployments may also require the same bearer-key auth model when configured.
- Remote mode uses a bearer API key as full-authority access to the backend.
- The backend trusts any holder of that key as the single user principal for the deployment.

## References to owning docs

- Product framing: `docs/product/overview.md`
- MVP scope and priorities: `docs/product/mvp-scope.md`
- Core product concepts and invariants: `docs/product/mental-model.md`
- Detailed execution mechanics: `docs/architecture/execution-model.md`
- Task semantics: `docs/product/task-model.md`
- Collection semantics: `docs/product/collection-model.md`
- Git defaults and project config: `docs/product/config/project-task-git-rules.md`
