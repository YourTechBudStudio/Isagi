# 0012-effect-v4-native-execution

status: accepted
date: 2026-10-09

## Context

Isagi's runtime, desktop shell, CLI and web app coordinate work that can fail, be cancelled or outlive a single call: Git, PTYs, commands, agent sessions, workflows, sockets and timers. Managed with ad hoc promises, callbacks and detached timers, that work hides who owns it, what can fail and when it stops at shutdown. The web app also kept server and UI state in a second asynchronous model (React Query and Zustand) with its own retry and cancellation rules.

## Decision

Isagi is built on Effect v4 throughout: runtime, desktop, CLI, web, contracts and runtime-client. The public surface of the workflow SDK and verifier is the exception. `effect` and every `@effect/*` package are pinned to one version through the pnpm catalog.

- Operational work (IO, processes, persistence, network, config) lives in services and layers. Pure code stays plain TypeScript.
- Effects run only at boundaries: process entries, the runtime's HTTP/WebSocket route runtime, the workflow engine, the web app's `lib/state`, and Electron lifecycle callbacks and IPC handlers. Everything else composes effects; a callback API is adapted once, at the edge that owns it.
- Work that outlives a call (fibers, subscriptions, child processes, loops) is owned by a layer's scope, so shutdown releases it.
- Expected failures are tagged errors that callers handle and API boundaries map to contract error codes. Defects are bugs.
- Contracts are schemas only: no Effect errors, services or effects cross the API boundary.
- Logging goes through Effect's logger.
- Web server state and UI state live in `effect/reactivity` atoms. This supersedes the tooling clause of ADR 0001; its ownership rules are unchanged.

## Not adopted

- `effect/http` server: Fastify stays the HTTP/WebSocket server.
- `effect/sql`: Drizzle with better-sqlite3 stays, behind the database service.
- `effect/process`: child processes stay on `node:child_process`, behind one platform adapter.
- `@effect/platform-node`: the runtime's `runMain` is a small in-repo helper.
- Effect in the workflow SDK and verifier: their public surface stays Promise-based, so workflow authors never need Effect.

## Consequences

- One failure, cancellation and lifecycle model runs from runtime services to UI state, without translation through untyped caches or stores.
- Effect is a foundational dependency of every package except the workflow SDK and verifier.
- Effect v4 is not compatible with v3: v3 APIs, examples and guidance do not apply.
- Some modules Isagi uses (`effect/reactivity`, the `effect/http` client) are unstable and may break in a minor release; the catalog pin keeps every upgrade deliberate.
- Effect provides mechanisms, not proof: where effects run and who owns long-lived work remain review responsibilities.
