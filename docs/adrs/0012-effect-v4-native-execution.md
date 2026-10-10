# 0012-effect-v4-native-execution

status: accepted
date: 2026-10-09

## Decision

Every Isagi package that uses Effect (runtime, desktop, CLI, web, contracts, runtime-client, and the `.mjs` scripts) runs on stable Effect v4 and follows one execution model: operational work is composed as Effects inside services and layers, runs only at a small, listed set of boundaries, fails with tagged errors, owns its resources through scopes, and logs through Effect. The detailed rules are in `docs/engineering-guidance/effect-conventions.md`; this ADR records the decisions behind them.

### Version and dependencies

- `effect` and every `@effect/*` package are pinned to one version through the pnpm `catalog:` in `pnpm-workspace.yaml`, at `~4.0.2`. The lockfile resolves exactly one `effect`.
- Core modules (`Effect`, `Layer`, `Context`, `Schema`, `Stream`, `PubSub`, `Fiber*`, `Logger`, `Runtime`, …) are `@stability stable`. `effect/reactivity`, `effect/http`, `effect/process`, `effect/sql`, `FileSystem`, `Path` and similar are `@stability unstable` and may break in a minor release. The `~` range accepts only patch releases; moving to a new minor is a deliberate catalog change verified by the full gate.
- Isagi uses only two non-core surfaces in production: `effect/reactivity` with `@effect/atom-react` (web state) and `effect/http` `HttpClient` (inside `@isagi/runtime-client`, and in desktop main for its health checks and dev web-server wait, always provided through `RuntimeHttpClient`). Tests also use `effect/testing`. `@effect/platform-node` is not a dependency.
- `@effect/schema`, `@effect/platform`, `@effect/experimental`, `@effect/rx*` and `effect/unstable/*` are banned.

### Services and layers

- Every service is a class: `class X extends Context.Service<X, Shape>()("isagi/<package>/<module>/<X>") {}` with `static readonly layer`. `Context.GenericTag`, the function form and separate same-named interfaces are gone. Ids are unique repo-wide and match `^isagi/(runtime|runtime-client|desktop|cli|web)/`; runtime module services use `isagi/runtime/<module>/<Class>`, runtime platform services `isagi/runtime/platform/<area>/<Class>`.
- Runtime layers are self-wired: a service's `static layer` provides its module dependencies by referencing their own `static layer`, and leaves platform services (data directory, database, state file, runtime config, user shell) and the two ports of ADR 0011 open. `layerNoDeps` exists on services with module dependencies so tests can supply fakes. Layer memoization by reference guarantees one instance of every service per runtime.
- `makeX({ deps })` factories and `XLive` names are not part of production APIs.
- Desktop composes its services in one `desktop-layer.ts`; the CLI and web provide their few services at their single boundary.

### Errors

- Expected failures are `Data.TaggedError` classes with tag equal to the class name, a small `reason`/`code` literal union where callers branch, and `cause: unknown` for wrapped foreign errors. Defects (`Effect.die` with an `Error`) are reserved for broken invariants.
- No operational signature declares an `unknown` error channel. The only exception is the input of the workflow SDK author bridge, classified in the same file.
- Runtime endpoint handlers are typed `Effect<Output, HandlerError<E>, R>`, where `HandlerError<E>` admits only `ApiRejected` with a rejection the endpoint's contract declares, plus platform infrastructure errors whose code the endpoint declares. Each endpoint maps its module errors with `Effect.catchTags` and `request.reject(...)`; an unmapped error is a compile error. Per-domain `mapError(error: unknown)` functions and `instanceof` chains are removed. Platform HTTP maps only platform errors (database, data directory, Git, project path validation); module-specific rejections are built by the owning module.
- Contracts stay Schema-only: no error classes, services, layers or effects cross the API boundary.

### Where effects run

`Effect.run*`, `ManagedRuntime.make`, `runtime.run*`, `FiberSet` runners (`.runtime`/`.runtimePromise`), `AtomRegistry.make` and `runMain` appear only at these boundaries, listed with a reason each in `scripts/architecture/effect-run-sites.json`:

- **Runtime process entry**: `apps/runtime/src/index.ts` runs `runMain(Layer.launch(MainLayer))`. `runMain` is built in `app/run-main.ts` on the stable core `Runtime.makeRunMain` (SIGINT/SIGTERM interrupt the main fiber; a requested shutdown exits 0, a startup failure prints the startup-failure line and exits 1). There is no production `ManagedRuntime` in the runtime.
- **Runtime HTTP and WebSocket boundary**: Fastify lives in a scoped `HttpServerLayer` (`app/http-server.ts`); requests and sockets run as fibers in a server-scoped `FiberSet` through `RouteRuntime<R>`, so shutdown interrupts and answers in-flight requests, then closes Fastify, then releases the service graph in reverse order along layer dependency edges (unrelated modules concurrently). `platform/http/route-runtime.ts` is the one place a Fastify request becomes a fiber (the endpoint helpers call it); the PTY stream route and the runtime-events socket fork one connection fiber per socket on the same runtime.
- **Workflow engine**: one bridge file, `workflows/engine/author-bridge.ts`, holds both Effect → Promise (author-facing contexts) and Promise → Effect (calling author code), using a runner captured from the engine scope. The engine (`workflows/engine/service.ts`) runs its run drivers and forked steps on an engine-scoped `FiberSet` runner, because they are started from synchronous code.
- **Desktop**: one `ManagedRuntime` over the desktop layer (`src/main/desktop-layer.ts`: `RuntimeProcess`, `DesktopUpdater`, `UpdaterDiagnostics`), used only from Electron lifecycle hooks and IPC handlers in `src/main/index.ts`. The one exception, in the same file, is recording an update-install rejection: the installer runs only after that runtime is disposed, so its requirement-free diagnostic effect runs with `Effect.runPromise` and the desktop logger.
- **CLI**: `apps/cli/src/main.ts` runs `Effect.runPromiseExit`; `bin.ts` calls it. The CLI does not use `runMain`, whose `process.exit` would truncate streamed stdout.
- **Web**: `lib/state/runtime.ts` (`runApp`, `forkApp`) and `lib/state/registry.ts` (`AtomRegistry.make`). Non-Effect web subsystems receive Promise-returning functions built with `runApp`.
- **Scripts** at their top-level entry, and **tests** through the shared test helpers.

Everything else composes effects. Callbacks, sockets and timers are adapted once at the edge module that owns the integration.

### Lifecycle and concurrency

- A layer's scope is its service's lifetime. Work that outlives a call is attached to it: `Effect.forkScoped`, `FiberSet`/`FiberMap`/`FiberHandle`, `Effect.acquireRelease`. `Effect.forkDetach`, `setTimeout`/`setInterval` in operational code, `Set<Promise>` trackers and busy counters are not used.
- In-process fan-out uses `PubSub` buses (`InternalEvents`, `RuntimeEvents`) whose `subscribe` is `Effect<Stream, never, Scope>` and subscribes eagerly in the caller's scope; `Stream.fromPubSub` in a forked consumer is not used because it loses events published before the consumer starts. Hand-rolled `Set<Queue>` buses are removed.
- Periodic work uses one platform helper built on fibers (first tick after one interval, ticks never overlap, failures logged and the loop continues).

### Logging

- Operational code logs with `Effect.log*` and structured annotations; `console.*` is banned in runtime source.
- The runtime provides one logger layer around the launched program: `Logger.withLeveledConsole(Logger.formatLogFmt)` plus `Logger.tracerLogger`. Debug and Info go to stdout, Warning and Error to stderr (today's split), one logfmt line per entry. `ISAGI_RUNTIME_DEBUG` lowers `References.MinimumLogLevel` to `Debug`.
- The `ISAGI_RUNTIME_READY` and `ISAGI_RUNTIME_STARTUP_FAILED` lines are protocol, written directly to stdout/stderr, never through the logger. CLI command output is product output written through the CLI's IO service.
- Spans come from `Effect.fn("<Class>.<method>")`; no exporter is configured.

### Infrastructure that stays

- **Fastify** stays the HTTP/WebSocket server (`effect/http` server is unstable).
- **Drizzle + better-sqlite3** stay behind the `RuntimeDatabase` service, which gains a typed transaction `abort`; `effect/sql` is not adopted.
- **Child processes** stay on `node:child_process` behind two `platform/process` adapters (`execCommand`, `spawnProcessGroup`); `effect/process` is not adopted.
- The **workflow SDK** and **verifier** packages stay Promise-shaped and do not depend on Effect.
- The **CLI** keeps its own parser and command table; `effect/cli` is not adopted.

### Web state

Web server state and UI state live in `effect/reactivity` atoms with `@effect/atom-react`. One `AtomRegistry` per app session is created explicitly (`makeAppRegistry` in `lib/state/registry.ts`) and provided through `AppStateProvider` (never `RegistryProvider`); every web effect runs against that registry's `appRuntime` over the `RuntimeApi` service. Server reads use one `query(read, policy)` constructor (`lib/state/policy.ts`) whose defaults reproduce the previous freshness behavior (10 s stale, revalidate on focus/reconnect, retry 3 times at 1/2/4 s, 5 min retention); invalidation uses `Reactivity` with flat string keys (`lib/state/keys.ts`); client state is keepAlive atoms with `(registry, …)` action functions. `@tanstack/react-query` and `zustand` are removed. This decision supersedes the frontend tooling clause of ADR 0001 (React Query for server state, Zustand for UI state); ADR 0001's ownership rules are unchanged.

## Motivation

Isagi was on Effect 3 with every service a `Context.GenericTag`, a hand-wired 345-line runtime composition file, `Effect.runPromise` re-entered deep inside PTY, GC and workflow code, `setInterval` loops and hand-rolled event buses, ~120 `console.*` calls, endpoint handlers typed `Effect<A, unknown>` mapped by `instanceof` chains, and a separate React Query + Zustand state stack in the web app. Each of those hides operational facts the principles ask to make visible: who owns a fiber, what can fail, when work stops at shutdown.

Effect 4 is the current stable line. Moving every consumer at once avoids running two Effect versions, and the port is the moment to adopt the shapes v4 makes natural: class services that carry their layer, scope-owned fibers instead of detached promises, typed boundaries the compiler checks, and Effect-native reactive state instead of a second state framework in the web app.

`runMain` on core `Runtime.makeRunMain` replaces the runtime's `ManagedRuntime` because one launched layer tree gives deterministic startup and shutdown order and deletes the lifecycle glue around Fastify; it is written in-repo (about 20 lines) instead of importing `@effect/platform-node`, which is unstable and pulls extra dependencies for that small amount of signal handling. Desktop keeps a `ManagedRuntime` because Electron owns the process lifecycle and builds services lazily after `whenReady`.

## Consequences

- Reviewers cite `effect-conventions.md` sections; the rules that can be checked mechanically are enforced by `scripts/architecture/index.mjs` (run sites, banned v3 APIs, dependency policy, service ids and Effect conventions) and oxlint (`no-console` in runtime source, restricted imports, `import/no-cycle`).
- Adding a run site means adding an allowlist entry with a reason; removing one means deleting its entry in the same change.
- A new expected failure needs a tagged error and, at the API boundary, an explicit mapping; forgetting the mapping fails compilation.
- Wire behavior is unchanged except the free-text `data.reason` of `api_request_decoding_failed` and `api_response_encoding_failed`, which now carries v4 schema error text. Codes, statuses and envelope shapes are identical.
- Runtime log lines become logfmt entries; consumers must not parse log text (the ready line is the protocol).
- Unstable Effect modules can change in a minor release; the catalog pin keeps that a deliberate, gated upgrade.
- Tests run through shared helpers (`@isagi/testing` for runtime, desktop, CLI and runtime-client; `lib/state/testing.ts` for web) with fresh layers or registries per test. Partial fakes use `Layer.mock`, except the web's single `RuntimeApi` fake, which `makeFakeRuntimeApi` builds as a shape.

## Notes

- Rejected: `effect/http` as the runtime server, `effect/sql`, `effect/process` `ChildProcess`, `effect/cli`, `@effect/platform-node` and `NodeRuntime.runMain` (unstable or unnecessary for the gain), a homegrown React Query on atoms, and adopting branded ids across all contracts in the same change.
- Runtime module structure is ADR 0011.
