# Effect Conventions

How Isagi code uses Effect v4. These rules apply to every package that uses Effect: `apps/runtime`, `apps/desktop`, `apps/cli`, `apps/web` operational and state code, `packages/contracts`, `packages/runtime-client`, `packages/testing`, and the `.mjs` scripts under `scripts/` and `apps/desktop/scripts/`. Implementers follow them literally; reviewers cite section numbers.

The decisions behind these rules are recorded in ADR 0012 (Effect v4 native execution). The runtime's directory and module layout is ADR 0011; where this guide says "module", it means an ADR 0011 module. The rules that can be checked mechanically are enforced (§16); the rest are review responsibilities.

Isagi's principles win over generic Effect style: Effect is the substrate for operational work, not a universal style for pure code (`principles.md`, `how-to-use.md`).

## 1. Where Effect goes

The tiers in `how-to-use.md` stay the review frame:

- **Tier 0** (pure helpers, constants, schemas, presentational React, reducers): plain TypeScript. A function that cannot fail, block, allocate, or depend on a service does not return an `Effect`.
- **Tier 1** (local async/failure/timeout flow): an `Effect` built with `Effect.gen`/`Effect.fn` and run at the nearest allowed boundary (§9).
- **Tier 2** (operational dependency: Git, persistence, process spawning, runtime client, config, harness integration): a `Context.Service` with a `layer` (§3). The default for runtime operational code.
- **Tier 3** (long-lived or concurrent: PTYs, commands, agent sessions, the workflow engine, event projection, garbage collection): Tier 2 plus scope-owned fibers, `PubSub`/`Queue`/`Stream`, periodic loops and interruption (§6–§8).

## 2. Imports and versions

- Import modules from the package root: `import { Context, Effect, Layer, Schema } from "effect"`. Subpaths only for non-core areas: `effect/testing` (`TestClock`, `TestConsole`; tests and `@isagi/testing`), `effect/reactivity` (web state), `effect/http` (`HttpClient`: `@isagi/runtime-client`, plus desktop main's dev web-server wait and health checks, always provided through `RuntimeHttpClient`). Never `effect/unstable/*` and never deep paths such as `effect/Effect`.
- Use `import type` for type-only imports.
- `effect` and every `@effect/*` dependency use `"catalog:"`; the catalog in `pnpm-workspace.yaml` pins them to one version (`~4.0.2`) and the lockfile resolves exactly one `effect`. Moving to a new minor is a deliberate catalog change, because `effect/reactivity`, `effect/http` and other `@stability unstable` modules may break in minors.
- `@effect/atom-react` is used only by `apps/web`. `@effect/platform-node`, `@effect/schema`, `@effect/platform`, `@effect/experimental` and `@effect/rx*` are not used.

## 3. Services and layers

### 3.1 Definition

```ts
export class CommandService extends Context.Service<
  CommandService,
  {
    readonly run: (input: {
      readonly worktreeId: number;
      readonly commandName: string;
    }) => Effect.Effect<CommandActionOutput, CommandServiceError>;
    readonly stop: (input: {
      readonly worktreeId: number;
      readonly commandName: string;
    }) => Effect.Effect<CommandActionOutput, CommandServiceError>;
    /* ... */
  }
>()('isagi/runtime/commands/CommandService') {
  static readonly layerNoDeps = Layer.effect(CommandService, make);
  static readonly layer = CommandService.layerNoDeps.pipe(
    Layer.provide([
      /* §3.3 */
    ]),
  );
}
```

- Always the class form `class X extends Context.Service<X, Shape>()("id") {}`. Do not use the function form `Context.Service<Shape>("id")` and do not keep a separate same-named `interface X` (the v3 `GenericTag` + interface pair is gone).
- Write the shape inline in the generic. If it exceeds about 12 members, declare `interface CommandServiceShape { ... }` directly above the class and write `Context.Service<CommandService, CommandServiceShape>()`. Code that needs the shape type uses `CommandService["Service"]`.
- Every member is `readonly`. Members are functions returning `Effect`/`Stream`, or `Effect`/`Stream` values for zero-argument operations (`readonly list: Effect.Effect<...>`). No Promise-returning members and no `unknown` error channels (§5.4). The ports of ADR 0011 that run inside a synchronous SQLite transaction (`ProjectDeletionParticipant.eraseInTransaction`) are the deliberate exception: their members are synchronous because no Effect may run inside a transaction (§3.5).
- Build the implementation object with `X.of({...})` so the shape is checked contextually.
- No `Live` suffixes and no `makeXService({ deps })` factories exported for production use. If a pure factory is useful for tests, it stays module-private and tests go through `X.layerNoDeps` or `X.layer` with fakes.

### 3.2 Service ids

The id string is the runtime identity of the service: two classes with one id collide in a `Context`. Ids are unique repo-wide and match `^isagi/(runtime|runtime-client|desktop|cli|web)/`.

| Owner                 | Id shape                                                                                | Example                                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| runtime module        | `isagi/runtime/<module>/<Class>`                                                        | `isagi/runtime/commands/CommandService`, `isagi/runtime/workspace/ProjectDeletionParticipant`                        |
| runtime platform area | `isagi/runtime/platform/<area>/<Class>`                                                 | `isagi/runtime/platform/events/InternalEvents`, `isagi/runtime/platform/persistence/RuntimeDatabase`                 |
| runtime-client        | `isagi/runtime-client/<Class>`                                                          | `isagi/runtime-client/RuntimeClient`                                                                                 |
| desktop               | `isagi/desktop/<area>/<Class>` (area = directory under `src/main`, omitted at its root) | `isagi/desktop/runtime-process/RuntimeProcess`, `isagi/desktop/updater/DesktopUpdater`, `isagi/desktop/DesktopShell` |
| cli                   | `isagi/cli/<Class>`                                                                     | `isagi/cli/CliContext`                                                                                               |
| web                   | `isagi/web/<Class>`                                                                     | `isagi/web/RuntimeApi`                                                                                               |

`<module>` is the owning ADR 0011 module (or platform area), not every nested folder: a service in `environment/agent-sessions/service.ts` is `isagi/runtime/environment/AgentSessionService`.

### 3.3 Layers and wiring

Runtime services are self-wired:

```ts
export class PtyService extends Context.Service<
  PtyService,
  {
    /* ... */
  }
>()('isagi/runtime/pty-processes/PtyService') {
  /** Construction only. Requires module dependencies and platform services. Used by tests that fake module dependencies. */
  static readonly layerNoDeps = Layer.effect(PtyService, make);
  /** Module dependencies wired by reference to their own `layer`; platform services and ports left open. */
  static readonly layer = PtyService.layerNoDeps.pipe(
    Layer.provide([
      CliAccess.layer,
      InternalEvents.layer,
      PtyBackendCatalog.layer,
      PtyForegroundState.layer,
      PtyRepository.layer,
    ]),
  );
}
```

- `static readonly layer` provides the service's **module** dependencies by referencing each dependency's own `static layer`, and leaves the **platform layer** services (§3.4) and the ADR 0011 ports open. `layerNoDeps` exists only on services that have module dependencies.
- A `static layer` may reference only layers of its own module, of modules it declares as dependencies, or of `platform/` areas. Each reference is an import, so the module-boundary checker enforces this.
- Every layer is memoized by object reference for the whole build, so a service referenced from several layers is constructed once and released after all its dependents. Never use `Layer.fresh` in production wiring and never create a second layer value for a stateful service. Parameterized layer factories are allowed only for platform layer services, which are provided exactly once at the root.
- Each module's `index.ts` exports one `<Module>Layer` (`CommandsLayer`, `WorkspaceLayer`, ...), a plain `Layer.mergeAll` of the services its routes and dependents use plus its background layers. `app/layer.ts` merges the module layers into `ModulesLayer`, provides the two ports (`PortsLayer`) and the platform layer (`PlatformLayer`), and asserts with `satisfies Layer.Layer<never, unknown, never>` that `AppLayer` has no open requirements. `RuntimeServices` is `Layer.Success<typeof AppLayer>`, never a hand-written union. `app/http-server.ts` builds `MainLayer` (the HTTP server over `AppLayer`), which `src/index.ts` launches.
- Variant implementations of one service get descriptive suffixes (`layer<Variant>`); independent backends may instead be separate services (`NodePtyBackend`, `TmuxBackend` behind `PtyBackendCatalog`). Choose between variants at the composition root; use `Layer.unwrap` when the choice depends on config.
- `static readonly layerTest` is allowed only for a deterministic in-memory implementation reused by tests in two or more modules. One-off fakes are written inline in the test (§14).
- `Layer.effect` is the constructor for effectful layers: it gives the constructor a `Scope` and removes it from `R` (`Layer.scoped` is gone). Use `Layer.succeed(X, X.of({...}))` for constant implementations and `Layer.effectDiscard` for background work that provides no service.
- Construction-time convergence a module owns (startup reconciliation, first GC, recovery) stays in that module's layer constructor. Background work a module owns (projections, GC loops, watchdogs) is a layer exported from its `index.ts` and merged into its `<Module>Layer`. Cross-module startup order lives in the composition root and calls public service methods only: `startup(url)` in `app/startup.ts` runs the steps that need the listening URL and ends with the ready line, and `HttpServerLayer` (`app/http-server.ts`) publishes the restored activation once every service is built and before any route runs.
- A module-level `const make = Effect.gen(function* () { ... return X.of({...}) })` above the class is fine: the generator body only runs when the layer builds.
- Desktop composes its services in `src/main/desktop-layer.ts`; the CLI and web provide their few services at their single boundary (§9).

### 3.4 Platform layer services and fiber-level references

- The runtime's **platform layer** holds services whose live implementation reads the process environment or owns a process-wide handle, and which tests always replace: `DataDirectory`, `RuntimeDatabase`, `StateFile`, `RuntimeConfig`, `UserShell`. They are merged once in `app/layer.ts` and left open by every module layer. (`StateFile` and `RuntimeConfig` are owned by `workspace` and `runtime-config`, but provided as platform layer services.)
- Other services, including those in `platform/` areas (Git, the event buses, the entity lock, the loopback port probe), are wired by reference like module dependencies and faked through `layerNoDeps`.
- Fiber-level references (`Logger`, `References.MinimumLogLevel`, `ConfigProvider`, and `TestClock` in tests) are not services. Service methods run in the caller's fiber, so a logger provided inside a layer reaches only that layer's construction. Provide them once around the whole launched program (§10), and in tests around the test effect.

### 3.5 State inside a service

- Mutable `Map`/`Set` captured in the layer constructor is acceptable when every read-modify-write happens synchronously inside one `Effect.sync` (JavaScript is single-threaded).
- When an update spans an async step (`yield*` between read and write), use `Ref`/`SynchronizedRef`, or serialize the critical section with a `Semaphore` (§8). Never rely on "no other fiber runs between these yields".
- Per-key long-lived work (one supervisor per PTY, one driver per run) lives in a `FiberMap` keyed by id, not in a hand-maintained `Map<id, Fiber>` (§6.2).
- `RuntimeDatabase.transaction(operation, (db, abort) => ...)` callbacks are synchronous: never `yield*` or `await` inside, and no Effect runs inside a transaction. Expected failures inside a transaction use the typed `abort(error)`, which rolls back and fails with that error, instead of throwing a tagged error and checking `instanceof` on the cause.

### 3.6 Objects that are really services

A class with private mutable fields whose methods return Effects is a `Context.Service` in disguise: its state lives in the layer constructor and its resources are registered with `Effect.acquireRelease`/`Effect.addFinalizer`. Desktop's `RuntimeProcess` and `DesktopUpdater` are built this way (status as a `SubscriptionRef`, timers as scoped fibers); the Electron app lifecycle owns one `ManagedRuntime` for their layers (§9).

## 4. Writing effectful functions

- **`Effect.fn("Name")(function* (...) {...}, ...combinators)`** for service methods and any reusable operation worth a span. Name service members `"<ClassName>.<method>"` and module functions `"<module>.<operation>"`. Combinators that apply to every call go in the extra arguments, not in `.pipe`. Annotate return types with `Effect.fn.Return<A, E>` when the inferred error union is not obviously right.
- **`Effect.fnUntraced(function* ...)`** for hot paths and tiny internal steps that are not useful spans: per-chunk PTY output handling, per-event projection steps, poll ticks, per-row loops, GC per-candidate steps, decode helpers.
- **`Effect.gen`** for inline effect values (layer constructors, one-off programs, tests). Do not write `(x) => Effect.gen(function* () {...})`; that is what `Effect.fn` is for.
- **Plain functions** for Tier 0. A pure helper used by an Effect stays pure and is called inside the generator.
- Always `return yield* new SomeError({...})` (not a bare `yield*`) so TypeScript knows control stops.
- `Option` and `Result` are not yieldable in `Effect.gen`; lift them with `Effect.fromOption`/`Effect.fromResult` or branch on them as plain values.

## 5. Errors

### 5.1 Classes

- Expected operational and domain failures are `Data.TaggedError` classes:
  ```ts
  export class HarnessSourceUnreadable extends Data.TaggedError('HarnessSourceUnreadable')<{
    readonly path: string;
    readonly reason: 'not_regular_file' | 'not_directory' | 'io' | 'disappeared';
    readonly cause: unknown;
  }> {}
  ```
- Use `Schema.TaggedError` only when the error instance itself must be encoded or decoded. Runtime errors never cross Isagi's HTTP API (contracts carry plain `ApiError` DTO schemas), so the default is `Data.TaggedError`. Contracts never export error classes.
- Tag = class name. One class per distinguishable failure that a caller handles differently; finer causes go in a small `reason` or `code` string-literal union that mirrors the contract's `data.reason` vocabulary (snake_case values). Handle string reasons with `catchTag` + `switch`; use `Effect.catchReason`/`catchReasons` only when `reason` is itself a union of tagged error classes.
- Wrapped third-party errors go in `readonly cause: unknown` untouched; do not stringify at wrap time. Every error that wraps a foreign exception also has a runtime-authored `message`; nothing renders `cause.message` to users (the safe-diagnostic protocol in `platform/diagnostics` is the trust boundary).
- Errors that can reach workflow author code carry a runtime-authored `message`, because v4 `runPromise` rejects with the error itself.
- `runtime-client`'s `RuntimeApiError`, `RuntimeTransportError` and `RuntimeDecodeError` are `Data.TaggedError`s.
- No new `class X extends Error` and no `throw new Error` for expected failures in operational code. The allowed `Error` subclasses are invariant violations used only with `Effect.die`, and private errors thrown by pure validators that are called through exactly one `Effect.try` at the module boundary.

### 5.2 Defects versus failures

- Failure (typed `E`): the caller can act on it, or it must map to a specific API error code or user-visible state: not found, rejected, conflict, an external system failed (Git, SQLite, filesystem, spawn, network).
- Defect: a bug or broken invariant. Produced only by `Effect.die(new XInvariantViolation(...))` (always an `Error`, so stacks survive; v4 has no `dieMessage`), `Effect.orDie` where the failure is proven impossible (comment why), or an unexpected throw inside `Effect.sync`.
- Third-party throws: wrap with `Effect.try`/`Effect.tryPromise({ try, catch })` into a typed failure when the throw is an expected condition (ENOENT, git exit codes, network). The single-function form `Effect.tryPromise(() => ...)` fails with `Cause.UnknownError` (generic message, original in `cause`); use it only where the error becomes a defect or a generic fallback.
- Pure parse/validate functions (project config normalize, path utils, state-file parse) may keep throwing a private error class, but are called only through one `Effect.try` at the module boundary that produces the module's tagged error.

### 5.3 Handling

- Prefer `Effect.catchTag("Tag", h)`, `Effect.catchTag(["A", "B"], h)` and `Effect.catchTags({...})`; they narrow the remaining error channel.
- `Effect.catch` only where every failure deliberately collapses to one fallback (best-effort probes, version lookup).
- `Effect.catchCause` only at supervision points: loop guards (the periodic-loop helper, per-event handlers), the HTTP/WebSocket boundary, the workflow engine's defect handler and startup reporting. Never wrap an effect that can self-interrupt inside a `forever`/`repeat` loop with `catchCause`: it catches the self-interruption (for example `Queue.take` on a shut-down queue) and the loop spins. In loops use `Effect.catch` (plus `Effect.catchDefect` if defects must be survived), or re-raise when `Cause.hasInterruptsOnly(cause)`.
- `Effect.ignore` only for best-effort cleanup that is already logged or explicitly irrelevant, with a comment.
- Replace `instanceof` chains with `catchTag` or `switch (error._tag)`. Mappers are total functions over a closed union, so adding a tag or reason breaks compilation: either an exhaustive `switch` with a declared return type and no `default` (a missing case fails with "function lacks ending return statement"), or a complete lookup table typed over every value, as `ReasonTable` in `workspace/api-reasons.ts` does:
  ```ts
  type ReasonTable<Reason> = { readonly [Code in WorkspaceError['code']]: Reason | null };
  ```

### 5.4 No `unknown` error channels; the API boundary

- Operational code never declares `Effect.Effect<A, unknown, R>`. Service members, module functions and endpoint handlers declare the closed union they can fail with. The only allowed `unknown` error channel is the input of the workflow SDK author bridge (`workflows/engine/author-bridge.ts`), classified in that file.
- Runtime endpoints are registered with `registerApiEndpoint(fastify, runtime, endpoint, handle)` from `platform/http` (`endpoint.ts`; content routes use `registerContentEndpoint` from `content-endpoint.ts`). The handler's type is `(request: ApiRequest<E>) => Effect.Effect<ApiEndpointOutput<E>, HandlerError<E>, R>`, where `HandlerError<E>` is `ApiRejected<Rejection<E>>` (a rejection whose code, status and reason the endpoint's contract declares) plus the platform infrastructure errors whose code the endpoint declares. Three mistakes are compile errors at the handler: an unmapped module error, an infrastructure error the endpoint does not declare, and a rejection outside the contract.
- Each endpoint maps its own module errors next to its registration with `Effect.catchTags` and `request.reject(...)`. Endpoint-dependent mappings are simply different `catchTags` at different endpoints; there is no shared `mapError(error, ctx)` keyed by endpoint id:
  ```ts
  registerApiEndpoint(fastify, runtime, apiEndpoints.projects.relocate, (request) =>
    WorkspaceService.use((workspace) =>
      workspace.relocateProject({ projectId: request.params.projectId, path: request.body.path }),
    ).pipe(
      Effect.catchTags({
        WorkspaceError: (error) =>
          withReason(relocationReasons, error, (reason) =>
            request.reject({
              code: 'project_relocation_rejected',
              status: error.code === 'project_path_already_registered' ? 409 : 400,
              message: error.message,
              data: { reason, projectId: request.params.projectId /* ... */ },
            }),
          ),
        StateFileError: notProduced,
        ProjectConfigError: notProduced,
      }),
      // Platform errors (DatabaseError, GitCommandError, ...) pass through: the contract declares them.
    ),
  );
  ```
- A mapper over a `code`/`reason` field is an exhaustive `switch` or complete table with no fall-through to an arbitrary code. If a service method can produce a reason the endpoint's contract lacks, narrow the method's error type (preferred) or mark it not produced and `Effect.die` (the table's `null`, `withReason`, `notProduced` in `workspace/api.ts`), which the helper answers `api_unhandled_error`.
- `platform/http` maps only platform errors (`DatabaseError`, `DataDirectoryError`, `GitCommandError`, `ProjectPathValidationError`) with today's codes, statuses, messages and data. Module-specific rejections are built by the owning module (for example `workspaceRejections` in `workspace/api-errors.ts` for project config, setup and state-file failures) and applied with `catchTags` at each endpoint.
- Defects and interruptions are handled by the helper, never by module code: a defect is logged with `Effect.logError` and answered `api_unhandled_error` 500; a client abort interrupts the handler and sends nothing; shutdown interrupts in-flight handlers and answers them 500.
- Handlers stay thin: `X.use((x) => x.method(...))` plus `catchTags`. No business logic in API files; reason tables and rejection builders live beside the API file (`workspace/api-reasons.ts`, `workspace/api-errors.ts`).

## 6. Resources, lifecycle, interruption

### 6.1 Scope ownership

- A layer's scope is its service's lifetime. Anything a service starts that outlives a single call (subscriptions, timers, child processes, PubSubs, fibers) is attached to that scope: `Effect.acquireRelease`, `Effect.addFinalizer`, `Effect.forkScoped`, or a `FiberSet`/`FiberMap`/`FiberHandle` created in the layer constructor. Acquisition order is release order reversed; order acquisitions so that what must shut down last is acquired first.
- Per-call resources use `Effect.acquireRelease` inside the method, with `Scope.Scope` in the method's `R` when the caller owns the lifetime (for example a PTY attachment held for the life of a WebSocket: the attachment detaches when the connection's scope closes). Otherwise close it inside the method with `Effect.scoped`.
- No hand-built root `Scope.make()` + `Scope.close()` in production code; that pattern stays only in test harnesses that must simulate a restart (use `Scope.provide(scope)`). A resource that must be releasable before its owner's scope closes lives in a child scope, `Scope.fork(yield* Effect.scope)`, closed early by its own release (PTY attachments in `pty-processes/service.ts` do this).

### 6.2 Forking rules

| Need                                                                                                               | Use                                                                                                              | Lifetime                                |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Concurrent sub-step that must finish or be interrupted with the current operation                                  | `Effect.forkChild`, or `Effect.all(..., { concurrency })`                                                        | Interrupted when the parent fiber ends  |
| Background loop owned by a service                                                                                 | `Effect.forkScoped` in the `Layer.effect` constructor, or the periodic-loop helper (§8)                          | Layer scope                             |
| Work started by a request or callback that must outlive it (retries, probes, run drivers, per-process supervisors) | `FiberSet.run(set, effect)` / `FiberMap.run(map, key, effect)` with the set or map made in the layer             | Layer scope                             |
| "Latest wins" single job                                                                                           | `FiberHandle.run(handle, effect)` (replaces the previous fiber)                                                  | Layer scope                             |
| Callback from third-party code must start Effect work                                                              | Deliver the fact into a `Queue` consumed by a fiber the layer owns (`Queue.offerUnsafe` in the callback, §7)     | Layer scope                             |
| Non-Effect caller must start Effect work (Fastify handlers, synchronous engine callbacks, author promises)         | `FiberSet.runtime(set)<R>()` / `FiberSet.runtimePromise(set)<R>()` over a set made in the layer; a run site (§9) | Layer scope; inherits the layer context |

- `Effect.forkDetach` is banned: nothing outlives the scope that owns it.
- Forked effects have `E = never`: handle and log failures inside the forked effect, because a failure in an un-joined fiber is otherwise invisible.
- Busy counters and `Set<Promise>` trackers are replaced by `FiberSet.size`, `FiberSet.awaitEmpty` and `FiberMap.has`.
- A forked child does not run before the parent's next yield. Do not rely on the child having started without a `Deferred` or `Latch` handshake.

### 6.3 Interruption

- Runtime HTTP requests and WebSocket connections run through `RouteRuntime<R>` as fibers in the server's request `FiberSet`. HTTP requests run with the client's `AbortSignal`, so a disconnect interrupts the request fiber; shutdown interrupts every request and connection before Fastify closes.
- A sequence that must complete atomically once started (persist row then publish event, kill process then record outcome) is wrapped in `Effect.uninterruptible` or moved into a service-owned fiber (`FiberSet.run`) so a client disconnect cannot cut it in half. Use `Effect.uninterruptibleMask((restore) => ...)` when only the waiting part should stay interruptible.
- `Effect.timeout`/`timeoutOrElse`/`timeoutOption` interrupt the source when the deadline wins; anything that must not be cut (commits) is inside an uninterruptible region.
- `Effect.onInterrupt`, `Effect.ensuring` and `acquireRelease` release functions are where kill and cleanup live; never a `finally` around a `runPromise`.

## 7. Adapting callback, promise and emitter APIs

Adapt once, at the edge module that owns the integration (for example `pty-processes/adapters/node-pty.ts`), so the rest of the module sees Effects, Queues and Streams.

- **One-shot callback** (child exit, socket connect, port probe): `Effect.callback<A, E>((resume, signal) => { ...; return Effect.sync(cleanup) })`. The returned effect is the interruption finalizer (kill the child, clear the timer, remove listeners). Prefer `Effect.timeout`/`timeoutOrElse` outside the callback over a `setTimeout` inside it.
- **Promise APIs**: `Effect.tryPromise({ try: (signal) => fetch(url, { signal }), catch: (cause) => new XFailed({ cause }) })`; pass the provided `AbortSignal` through so interruption cancels the work.
- **Multi-shot sources** (PTY data, process output lines, filesystem watchers, WebSocket messages): either push into a `Queue` the consumer owns (`Queue.offerUnsafe`, `Queue.endUnsafe` when the source ends) from synchronous callbacks, or build a `Stream.callback<A, E>((queue) => Effect.acquireRelease(register, unregister))` that pushes with `Queue.offerUnsafe`, completes with `Queue.endUnsafe` and fails with `Queue.failCauseUnsafe`. For DOM-style targets use `Stream.fromEventListener`.
- **Callback that must start Effect work** (node-pty exit, foreground-command changes): deliver the fact into a queue consumed by a supervisor fiber (the node-pty and tmux adapters push `Exited`/output/foreground events with `Queue.offerUnsafe`). A `FiberSet` runner (§6.2) only at a listed run site. Never `void Effect.runPromise(...)` inside a callback.
- **WebSockets**: `acquireWsConnection(socket)` in `platform/http/websocket.ts` adapts a socket into a scoped connection (`incoming` stream, `send`, `close`, `closed`). Route code never registers socket listeners itself.
- **Child processes**: only `platform/process` imports `node:child_process`. `execCommand` runs exec-style commands with the interruption signal wired to the child; `spawnProcessGroup`/`terminateGroup` spawn a detached process group whose scope finalizer kills the group if the leader is still running. Timeouts are Effect-native (`Effect.timeoutOption(group.exit, timeout)` then `terminateGroup`). `effect/process` is not used. `node-pty` is imported only by the `pty-processes` adapters.
- **Effect → Promise for a public contract** (workflow SDK operations) and **Promise → Effect for author code**: only in `workflows/engine/author-bridge.ts`, using a runner captured from the engine's scope (`FiberSet.runtimePromise`), so bridged work inherits services and is interrupted on shutdown. Author code is called with `Effect.tryPromise` into a tagged `AuthorCodeFailed`.

## 8. Concurrency primitives

- **PubSub** for in-process fan-out (`InternalEvents`, `RuntimeEvents`). A bus is a service exposing `publish(event)` and `subscribe: Effect.Effect<Stream.Stream<Event>, never, Scope.Scope>`, built on `PubSub.subscribe`, which subscribes eagerly in the caller's scope: every event published after `subscribe` returns is delivered. Never use `Stream.fromPubSub` in a forked consumer; it subscribes lazily and loses events published before the fiber starts. Consumers subscribe first, then fork the consumer: `const events = yield* bus.subscribe([...]); yield* events.pipe(Stream.runForEach(handle), Effect.forkScoped)`, with per-event failure handling inside `handle`. Subscriptions that must precede startup work (the harness observer subscribes before its startup inventory) subscribe in the layer constructor before that work. Shut the PubSub down in the layer finalizer. Use `PubSub.unbounded` unless a slow subscriber must apply back-pressure (then `bounded` with an explicit capacity and a documented strategy). Hand-rolled `Set<Queue>` buses are not used.
- **Queue** for single-consumer hand-off (WebSocket outbound frames, adapter events, work queues). Use module functions only (`Queue.offer`, `offerUnsafe`, `take`, `shutdown`, `end`). Use `Queue.Queue<A, Cause.Done>` with `Queue.end` for finite sequences and consume with `Stream.fromQueue`. `Queue.take` on a shut-down queue interrupts the taker.
- **Semaphore** (`Semaphore.make(1)`, `Semaphore.withPermits(sem, 1)(effect)`) for per-service critical sections; keyed locks use the entity lock in `platform/locks`.
- **Deferred** for one-shot handshakes (gate a forked fiber until registration completes). **Latch** for open/close gates.
- **Periodic loops**: services use `runPeriodically(name, every, tick)` from `platform/fibers`. The first tick runs one interval in (`setInterval` parity), ticks never overlap, failures and defects are logged at `Warning` and the loop continues, and the fiber is forked into the caller's scope. Elsewhere use `Schedule`: `Effect.schedule(work, Schedule.spaced(d))` for "first run after the interval", `Effect.repeat(work, Schedule.spaced(d))` for "run now, then every interval", `Effect.delay(d)` for a delayed single attempt, `Effect.retry({ schedule, times, while })` for retries. `repeat` and `schedule` stop on the first failure, so loops catch per-iteration failures before the schedule.
- **Delays that shutdown must cut short** (for example persistence retries that drain at shutdown) race `Effect.sleep` against a `Deferred` completed by the owning scope's finalizer; a `Schedule`-driven `Effect.retry` cannot be cut short that way.
- **Stream** for sequences over time (PTY output, events, line-oriented child output) instead of callback arrays and manual buffers. A queue that receives live output while a replay is sent is the buffer; do not add buffering flags around it.
- No `setTimeout`/`setInterval` in operational code (enforced for `apps/runtime/src` by E5, §16). The web app's DOM and terminal subsystems and its atom transforms (`pollWhile` in `lib/state/policy.ts`) may use DOM timers when a finalizer or cleanup clears them.

## 9. Where `Effect.run*` is allowed

Running an effect is a boundary act. A run site is any `Effect.run{Promise,Sync,Fork,Callback}{,Exit,With}`, `ManagedRuntime.make`, `runtime.run*`, `FiberSet`/`FiberMap`/`FiberHandle` `.runtime`/`.runtimePromise` (they hand plain run functions to non-Effect callers), `AtomRegistry.make`, `Runtime.makeRunMain` or a `runMain(...)` call. Allowed sites, exhaustively:

1. **Runtime process entry**: `apps/runtime/src/index.ts` runs `runMain(Layer.launch(MainLayer).pipe(Effect.provide(RuntimeLogger.layer), ...))`. `runMain` lives in `app/run-main.ts`, built on the stable core `Runtime.makeRunMain`: SIGINT/SIGTERM interrupt the main fiber, a requested shutdown exits 0, a failure exits 1 after the startup-failure line. There is no production `ManagedRuntime` in the runtime, and `@effect/platform-node` is not used.
2. **Runtime HTTP and WebSocket boundary**: `app/http-server.ts` creates the request `FiberSet` and its runners and hands them to routes as `RouteRuntime<R>`. `platform/http/route-runtime.ts` is the one place a Fastify request becomes a fiber: the endpoint helpers (`registerApiEndpoint`, `registerContentEndpoint`) call its `runRouteRequest` and `watchContentStream`. The PTY stream route (`pty-processes/stream-route.ts`) and the runtime-events socket (`runtime-events/api.ts`) fork one scoped connection fiber per socket with `runtime.runFork`. Module `api.ts` files hand effects to the helpers and never call `run*` themselves.
3. **Workflow engine**: `workflows/engine/author-bridge.ts` (the SDK Promise bridge, §7) and `workflows/engine/service.ts`, whose run drivers and forked steps keep synchronous `kick`/`fork` signatures and run on an engine-scoped `FiberSet.runtime`.
4. **Desktop main process**: Electron lifecycle hooks and IPC handlers in `apps/desktop/src/main/index.ts`, through the one desktop `ManagedRuntime` built from `desktop-layer.ts`. No other desktop file runs effects.
5. **CLI**: `apps/cli/src/main.ts` (`runCli`, `Effect.runPromiseExit`) only; `bin.ts` calls `runCli`. The CLI does not use `runMain`, whose `process.exit` can truncate streamed stdout.
6. **Web**: `lib/state/runtime.ts` (`runApp`, `forkApp`) and `lib/state/registry.ts` (`AtomRegistry.make`). Components and helpers never call `Effect.run*`. Non-Effect subsystems (terminal presentation, PTY streams) receive Promise-returning functions built with `runApp(registry, effect, { signal })`, for example `fetchInventory: (signal) => runApp(registry, fetchDurableSessions(), { signal })`.
7. **Scripts** (`scripts/**/*.mjs`, `apps/desktop/scripts/**/*.mjs`): the script's top-level entry. The run-site check scans `scripts/` only; desktop scripts are a review responsibility.
8. **Tests**: through the test helpers (§14).

Everything else composes Effects: deep re-entries are rewritten with the §6.2, §7 and §8 primitives. `Effect.runSync` is allowed only on effects that are synchronous by construction, at the same boundaries (it throws otherwise).

The allowlist is `scripts/architecture/effect-run-sites.json` (file → reason). The check fails on a run site outside the list and on stale entries. A change that removes a file's run sites deletes that file's entry in the same change; adding an entry needs a stated reason and integrator approval.

Notes: v4 `runPromise` rejects with the squashed failure itself (there is no `FiberFailure` wrapper). A pending `Effect.runFork(Effect.never)` does not keep Node alive; process lifetime comes from Fastify, Electron, IO handles or `runMain`.

## 10. Logging and tracing

- Operational code logs with `Effect.logDebug`, `logInfo`, `logWarning` and `logError`. No `console.*` in operational code. Exceptions: the runtime's `ISAGI_RUNTIME_READY` line (stdout) and `ISAGI_RUNTIME_STARTUP_FAILED` line (stderr), which are protocol lines written directly with `process.stdout.write`/`process.stderr.write`; desktop's forwarding of the runtime child's output, which is also a protocol; CLI command output, which is the product and goes through the `CliContext` IO; desktop main glue that runs outside any Effect (Electron callbacks in `index.ts`, `development.ts`); and the web app's browser-only diagnostics.
- Levels: `Debug` is what `ISAGI_RUNTIME_DEBUG` used to gate (diagnostic events, phase traces, slow-request diagnostics); `Info` is lifecycle milestones (startup, restore summary, migration); `Warning` is degraded but handled (a GC tick failed, a retry was abandoned, event-loop lag); `Error` is unhandled defects at boundaries. Do not log and also return the same expected failure; the boundary logs once.
- Messages are static; data goes in annotations: `Effect.logInfo("PTY launch starting").pipe(Effect.annotateLogs({ ptyProcessId, command }))`, or `Effect.annotateLogs` as an `Effect.fn` combinator for a whole operation. Pass a `Cause` as an argument when there is one. Use `Effect.withLogSpan("label")` for durations. Standard annotations: `endpointId` and `requestId` (request pipeline), `ptyProcessId` (PTY supervisors), `loop` (periodic loops), `runId` (workflow engine), `component` (instead of `[runtime][x]` prefixes).
- Redaction: never log secrets, env values, prompt or agent output, or file contents. Anything that may echo user data (backend refs, env, command lines, process output, schema errors of refs) is logged through the safe-diagnostic description of its cause, as an annotation, not as a raw cause. Raw causes are fine for defects and runtime-authored errors.
- The runtime's logger (`app/logger.ts`) is provided outermost in `src/index.ts`, around the launched program, never inside a module layer:
  ```ts
  export const RuntimeLogger: { readonly layer: Layer.Layer<never, Config.ConfigError> } = {
    layer: Layer.unwrap(
      Effect.map(runtimeDebug, (debug) =>
        Layer.mergeAll(
          Logger.layer([Logger.withLeveledConsole(Logger.formatLogFmt), Logger.tracerLogger]),
          Layer.succeed(References.MinimumLogLevel, debug ? 'Debug' : 'Info'),
        ),
      ),
    ),
  };
  ```
  `Debug` and `Info` go to stdout, `Warning` and `Error` to stderr (the split `console.info`/`console.warn` had), one logfmt line per entry with newlines escaped, so a multi-line cause stays one forwarded record. `Logger.layer([...])` replaces the whole logger set, so `Logger.tracerLogger` must be listed or span log events disappear. The default minimum level is `Info`, so `logDebug` is silent unless `ISAGI_RUNTIME_DEBUG` lowers it.
- Desktop uses its own logger layer, `DesktopLogger` in `src/main/desktop-logger.ts` (`[desktop] <message>` lines with annotations, Debug/Info on stdout and Warning/Error on stderr), merged into the desktop layer so it reaches every effect the `ManagedRuntime` runs. The runtime child's output is forwarded by `runtime-process/logging.ts`, not through this logger.
- Spans: `Effect.fn("Name")` creates the span; `Effect.withSpan("<Class>.<member>")` names inline effect values that are not functions (zero-argument members such as `WorkspaceService.get`). No exporter is configured; span names appear as frames in defect logs.
- The event-loop watchdog and phase markers in `platform/diagnostics` keep their behavior; their output goes through `Effect.log*`. The watchdog uses the live clock.

## 11. Config and References

- Environment variables are read with `Config` inside layer constructors or settings values used at the composition root (`RuntimeSettings` for `HOST`, `PORT`, `ISAGI_RUNTIME_DEBUG`). A config error is a startup failure. When moving an existing environment read onto `Config`, preserve its parsing exactly: read the raw string (`Config.String("PORT").pipe(Config.withDefault(""))`) and map it through the existing pure parser when `Config`'s own parsers would accept or reject different inputs.
- Isagi's own config files (`config.yaml`, per-project `.isagi` config) stay in their `runtime-config` and `projects` services; do not move them into `ConfigProvider`.
- Tunables with defaults that tests override (probe timings, GC intervals, retry delays, deadlines) are `Context.Reference`s owned by the module:
  ```ts
  export const PtyProcessSettings = Context.Reference<PtyProcessTimings>(
    'isagi/runtime/pty-processes/PtyProcessSettings',
    {
      defaultValue: () => ({
        statusPollInterval: Duration.seconds(10),
        garbageCollectionInterval: Duration.minutes(5),
        persistenceRetryDelay: Duration.seconds(1),
      }),
    },
  );
  ```
  Tests provide `Layer.succeed(PtyProcessSettings, {...})`. This replaces `options?: { delayMs?, timing? }` bags threaded through factories.
- Built-in references used: `References.MinimumLogLevel`; nothing else by default.

## 12. Schema

- **Contracts** (`packages/contracts`): functional schemas only, `export const xxxSchema = Schema.Struct({...})` with types as `export type Xxx = typeof xxxSchema.Type`. No `Schema.Class`, no `Schema.TaggedError`, no services or effects; contracts import nothing from `effect` but `Schema` and `SchemaTransformation`. Endpoint descriptor slots are bounded by `Schema.Codec<unknown>` (a codec that needs no decoding or encoding services). `.literals` arrays read by Drizzle table enums and the CLI stay identical.
- **`Schema.Unknown` properties**: v4 rejects a missing key that v3 accepted. In contracts, and in every runtime-internal schema whose `Unknown` property can be absent or `undefined` (persisted JSON columns, `state.json`, harness ledgers), write `<prop>: Schema.optionalKey(Schema.Unknown)`.
- **Runtime parsing of untrusted data** (config files, child-process JSON, persisted JSON columns, harness ledgers): inside Effect code use `Schema.decodeUnknownEffect(schema)(input)` and map `Schema.SchemaError` to the module's tagged error. In non-Effect code use `Schema.decodeUnknownResult`. `decodeUnknownSync` only where the throw is immediately caught at a boundary.
- **Replacing a hand-written parser** of persisted or user-authored data with a Schema is allowed only if the Schema accepts exactly the inputs the old parser accepted, with the same defaults, proven by an equivalence test with a fixture for every lenient branch of the old parser. A stricter decode of persisted data can silently reset users' state. `state.json`'s parser is deliberately not a Schema: it stays a pure validator called through one `Effect.try` → `StateFileError`, because it defaults a missing or `null` `activeContextRevision` to 0 and missing ids to `null`.
- **Error text**: v4 `SchemaError.message` is `"<message>\n  at [\"a\"][0]"`, without the v3 tree and without the actual value. Code that renders schema problems to users (project config) builds its own text from `SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues` (`{ path, message }[]`) and passes `{ reportInput: true }` when the offending value should be shown. Never parse `.message` text. The runtime's request-decoding and response-encoding envelopes carry the v4 message in `data.reason`; clients must not assert on that text.
- Do not add Schema validation to purely internal, already-typed data.

## 13. Branded IDs

Brands are for operational targeting values that cross a boundary and sit next to sibling ids of the same primitive type (worktree, surface, pane, session and PTY process ids, refs, data-root-relative paths).

- Define them in contracts as schema brands: `export const WorktreeId = Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.brand("WorktreeId"))`, `export type WorktreeId = typeof WorktreeId.Type`; values come from decoding or `WorktreeId.make(n)` (which validates).
- Not adopted wholesale, and no contract defines a brand yet: branding every id DTO would ripple through every contract, web atom key, CLI table entry and Drizzle row mapping. New code that takes two or more id parameters of the same primitive type in one signature should brand them; existing ids are a separate story.

## 14. Testing

The runner is `node:test` with `node:assert/strict`, run through `tsx`.

1. **Helpers run Effect tests.** Runtime, desktop and CLI tests use `@isagi/testing`: `runScoped(effect)` (live clock plus a scope that closes after the test; the replacement for `Effect.runPromise` in tests), `runWithTestClock(effect)` (adds `TestClock` and `TestConsole`; only for time-driven tests, never the default, because IO tests with real timeouts would hang), `makeLogCapture()`, `makeFiberProbe()`, `expectNoNewHandles(effect)` and `expectNoProcessMatching(marker)`. Both runners reject with `Cause.squash(cause)`, so `assert.rejects(..., SomeTaggedError)` works. Web tests use `lib/state/testing.ts` (item 8).
2. **Fresh layers per test.** Plain `Effect.provide(layer)` builds a new memo map when no outer one exists, so sibling tests do not share instances. Do not provide test layers inside a `ManagedRuntime` or an outer provide of the same layer reference unless sharing is intended.
3. **Time.** `TestClock` + `TestClock.adjust(d)` through `runWithTestClock`. No real sleeps to "give fibers a turn"; use `Effect.yieldNow`, `Deferred` or `FiberSet.awaitEmpty`.
4. **Fakes.** `Layer.succeed(X, X.of({...}))` for full fakes; `Layer.mock(X)({ onlyTheMembersUsed })` for partial fakes (unimplemented members die with an `UnimplementedError` naming the service and member), replacing hand-written `Effect.die("… is not used")` stubs. Services with synchronous non-Effect members (the ADR 0011 ports) are faked with `Layer.succeed`, because `Layer.mock` does not stub them. Module dependencies are faked through `X.layerNoDeps.pipe(Layer.provide(fakes))`. Tunables via `Layer.succeed(SomeReference, value)`. Fakes record calls lazily (inside `Effect.sync`/`Effect.suspend`), because building an effect is not running it.
5. **Assertions on failures** use `Effect.flip`, `Effect.result` or `Exit` + `Cause.findErrorOption`, not `try/catch` around a run.
6. **Log capture** with `makeLogCapture()` (a `Logger.layer([...])` collector) instead of mocking `console`.
7. **Lifecycle-sensitive tests** (PTYs, commands, the workflow engine, GC, restore, sockets) close the scope and assert finalizers ran: child killed, listeners removed, fibers empty (`makeFiberProbe`), no new handles, no leftover processes.
8. **Web** tests build one isolated registry per test with `makeTestRegistry({ api, retry, initialValues })` (`api` is a partial fake `RuntimeApi`; unspecified members die with "`RuntimeApi.<member>` is not used") and always `t.after(() => registry.dispose())` (retained queries hold timers that keep the process alive). Time is driven with node's `mock.timers` (`setTimeout` and `Date`), not `TestClock`, which cannot drive reactivity timers; run `flush()` before `mock.timers.tick` so scheduled node removals run first.
9. **Scope of the rule.** Tests a change creates or substantially edits follow this section. Untouched existing tests may keep their direct `Effect.runPromise` calls.

## 15. Do not

- Do not wrap pure code in Effect (`Effect.succeed(compute(x))` chains, `Effect.sync` around arithmetic, Effect-returning formatters).
- Do not make a service for every helper or group of functions. A service exists when there is an operational dependency to swap, a resource to own, or state with a lifetime.
- Do not export `makeX(deps)` factories or `XLive` layers as the production API next to a service.
- Do not use `Effect.forkDetach`, `Effect.runPromise`/`runFork` inside modules, `setTimeout`/`setInterval` in operational code, `Set<Promise>` trackers, busy counters, or hand-rolled event buses.
- Do not subscribe to a PubSub with `Stream.fromPubSub` in a forked consumer (§8).
- Do not declare `unknown` error channels, map errors with `instanceof` chains, or write a shared `mapError(error: unknown, ctx)` for endpoints (§5.4).
- Do not `catchCause` around self-interrupting effects inside loops (§5.3).
- Do not `console.*` in operational code (§10).
- Do not expose Effect services, layers, fibers, `Effect`/`Stream` types or error classes from `packages/contracts`.
- Do not put Promise-returning members on services; do not return `Effect` from React components or pure selectors.
- Do not import from `effect/unstable/*` or deep module paths; do not pin `effect` or `@effect/*` outside the catalog.
- Do not use `Schema.Class` in contracts or parse `SchemaError.message` text.
- Do not use `RegistryProvider` from `@effect/atom-react` (it creates a second registry); provide the app registry through `AppStateProvider`.
- Do not wire a dependency in `X.layer` that is not a module dependency of `X` (its own module, a declared dependency, or `platform/`), and do not provide platform layer services or ports inside a module layer: those are provided once in `app/layer.ts` (§3.3).

## 16. Enforcement

Mechanical rules are enforced by one runner, `node scripts/architecture/index.mjs`, which is part of `pnpm lint` and has per-check `enforce`/`report` modes in a table at its top. Read the scripts for the exact rules:

- `module-boundaries.mjs` with `apps/runtime/module-boundaries.json`: the ADR 0011 rules R1–R12, all enforced, including R9 (external-package confinement, for example `node:child_process` only in `platform/process`).
- `effect-run-sites.mjs` with the `effect-run-sites.json` allowlist (§9).
- `effect-v3-apis.mjs`: v3-only Effect names and banned imports in untyped `.mjs` files (`tsc` guards `.ts`).
- `dependency-policy.mjs`: banned packages (React Query, Zustand and the v3-era Effect packages), `catalog:` for every Effect dependency, one resolved `effect` version.
- `effect-conventions.mjs`: rules E1–E7 on production files: E1 no function-form services; E2 service and reference ids per §3.2 and unique; E3 no `Effect.forkDetach`; E4 no `unknown` error channels outside the author bridge; E5 no `setTimeout`/`setInterval` in runtime source; E6 runtime `extends Error` only for the allowlisted invariant and pure-validator classes; E7 contracts import only `Schema`/`SchemaTransformation` from `effect`.

oxlint adds `import/no-cycle` and `no-console` for `apps/runtime/src/**` (`*.test.ts` files excluded) in the nested `apps/runtime/.oxlintrc.json`, and `no-restricted-imports` for `effect/unstable/*`, `@effect/schema`, `@effect/platform`, `zustand`, `@tanstack/react-query` and `RegistryProvider` in the root `.oxlintrc.json`. Each script has self-tests under `scripts/architecture/*.test.mjs`.

Everything else in this guide (`Effect.fn` naming, scope ownership, error granularity, log levels) is a review responsibility.
