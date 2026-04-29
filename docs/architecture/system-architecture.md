# System Architecture

**Last updated:** 2026-04-28

This document defines the zoomed-out architecture for Isagi. Product concepts live in `docs/product/mental-model.md`; runtime execution mechanics live in `docs/architecture/execution-model.md`.

## Architectural goals

- Make Isagi the primary user-facing interface for continuing project work.
- Keep durable planning state Git-backed where practical.
- Keep runtime/session state owned by the backend.
- Preserve one runtime model across local and remote deployment modes.
- Support multiple agent harnesses behind a stable Isagi contract, starting with OpenCode.
- Stay desktop-first and single-user in the active MVP.

## Source-of-truth split

- `.isagi/` files own durable planning state: milestones, tasks, sparks, and project config.
- The backend owns runtime/session state: sessions, harness bindings, execution roots, worktree bindings, collision state, and transient runtime metadata.
- The backend may index or project `.isagi/` planning artifacts, but indexing is optional and rebuildable.
- If an index conflicts with files, files win for planning state.

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

- render project, milestone, task, and session surfaces
- consume Isagi API responses and event streams
- present session controls and execution visibility
- make `.isagi/` planning artifacts easier to navigate without replacing Git review

### API backend

The API backend is the runtime authority.

Responsibilities:

- own session records and runtime metadata
- own repo registration and backend-visible repo paths
- own execution roots, managed worktrees, and git operations
- orchestrate harness runtimes and session lifecycle
- normalize runtime events into Isagi's event model
- optionally index `.isagi/` planning artifacts for UI convenience

### Internal harness adapters

Harness adapters live inside the API backend.

Responsibilities:

- translate Isagi session operations into harness-specific operations
- translate harness responses and events into Isagi-owned runtime concepts
- hide harness-specific API details from the rest of Isagi

### External agent harness runtimes

Agent harnesses such as OpenCode remain external runtimes.

Responsibilities:

- run the underlying agent loop
- manage harness-native session history and execution
- expose harness-specific APIs or process interfaces that the backend integrates with

## Deployment modes

### Local mode

In local mode:

- the desktop shell starts the API backend as a companion process
- repos and worktrees live on the local machine visible to that backend
- auth may be disabled only when the backend remains loopback-bound

### Remote mode

In remote mode:

- the desktop shell connects to a separately hosted API backend
- repos and worktrees live on the filesystem visible to that remote backend
- the system remains single-user in the MVP
- a bearer API key grants authority over the backend

## Core architectural invariants

1. The API backend is the runtime authority.
2. `.isagi/` files are the source of truth for durable planning state.
3. Backend planning indexes are optional and rebuildable.
4. Local and remote modes share the same domain model.
5. Each Isagi session maps to one harness session.
6. Each session is bound to one execution directory for its lifetime.
7. Changing execution directory closes the current session and creates a new session instead of rebinding the same session.
8. Harness-specific capabilities stay behind adapter boundaries.

## Trust model

- The active MVP is single-user in both local and remote modes.
- Local mode may run without auth only when the backend is loopback-bound.
- Remote mode uses a bearer API key as full-authority access to the backend.
- Transport security is outside Isagi's scope.

## References

- Product framing: `docs/product/overview.md`
- MVP scope: `docs/product/mvp-scope.md`
- Mental model: `docs/product/mental-model.md`
- Planning artifacts: `docs/product/planning-artifacts.md`
- Execution mechanics: `docs/architecture/execution-model.md`
- Git defaults: `docs/product/config/project-task-git-rules.md`
