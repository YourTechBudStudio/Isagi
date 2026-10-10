# Runtime Behavior, Effects, And Diagnostics

## What This Lens Protects

This lens protects operational truth: lifecycle clarity, Effect usage, failure semantics, diagnosability, cancellation, resource ownership, and early-user supportability.

Isagi will launch and manage Git worktrees, commands, PTYs, agent sessions, surfaces, runtime state, and restoration behavior. When these fail, the product should make the failure understandable to the user and diagnosable by the maintainer.

Effect is the substrate for this operational work. That does not mean Effect everywhere; it means async work, failure, retries, dependencies, cancellation, long-lived resources, and shutdown behavior should be explicit where they matter.

This lens reviews operational work once it exists: lifecycle, failure behavior, cancellation, resource ownership, and diagnostics. Use `state-flow-causality-and-operational-cost.md` when the primary question is whether that work is attached to the right trigger or hidden behind an action that should be lightweight.

## Review Questions

- Is runtime state owned by the runtime rather than inferred or over-owned by the UI?
- Are Git and filesystem facts rediscovered from their real source where practical?
- Is lifecycle ownership clear for processes, PTYs, commands, agent sessions, background fibers, and persisted state?
- Can the behavior orphan, leak, mis-associate, or misrepresent runtime state?
- Does operational code compose Effects internally and run them at framework or process boundaries?
- Are `Effect.runPromise`, `Effect.runSync`, or `Effect.runFork` used deliberately at boundaries rather than deep inside reusable operational modules?
- Is the code at the right Effect maturity tier for its complexity: local Effect, service/layer, or scoped concurrent system?
- Do operational domains with IO, config, persistence, Git, process, runtime-client, or adapter dependencies expose those dependencies through services/layers once the domain needs replacement, testing, or lifecycle clarity?
- Are scoped resources, interruption, shutdown, and cleanup explicit for long-lived processes, streams, queues, sessions, and supervisors?
- Is every fiber, subscription, child process, or periodic loop a runtime service starts attached to that service's layer scope, so shutdown releases it?
- Does a new run site sit at one of the allowed boundaries, and do third-party callbacks reach Effects through a queue, stream, or layer-owned `FiberSet` runner instead of `Effect.runPromise`?
- Does an event-bus consumer subscribe in its own scope before it forks, and before any startup work that may publish?
- Does each API handler map its module's tagged failures next to the endpoint, to a code that endpoint's contract declares?
- Is each log entry at the right level, with a static message, identifiers as annotations, and user data only through its safe description?
- Are expected domain and operational failures represented as tagged, structured data/errors rather than generic `Error` values or stringly status messages?
- Are expected messages, findings, events, and state variants tagged where callers need to distinguish them deliberately?
- Are branded, opaque, or otherwise narrow domain types used where plain strings/numbers would make important project, worktree, session, path, ref, or token mixups likely?
- Are unexpected defects distinguishable from expected domain failures?
- Are failures surfaced instead of silently swallowed?
- Are tagged domain failures mapped into explicit API errors at runtime boundaries rather than leaking implementation errors?
- Are validation failures, domain failures, internal failures, and degraded-runtime behavior distinguishable where clients or users need different handling?
- Does degraded behavior remain honest about what did and did not work?
- Would a user be able to report enough information for remote debugging?
- Do logs or error payloads include useful context without dumping noise or sensitive data unnecessarily?
- Are command failures, integration limitations, and restoration failures visible where they matter?
- Does verification cover the risky lifecycle paths, not only the happy path?

## Isagi-Specific Notes

- Package-scoped `AGENTS.md` files define the local Effect scope for each package. Keep this lens focused on operational review questions rather than package policy.
- Isagi aims for Tier 2 by default in operational code and Tier 3 when lifecycle complexity justifies scopes, fibers, queues, streams, supervisors, or structured shutdown.
- New or touched expected operational failures should generally be tagged and structured. Existing generic errors can be improved opportunistically when the surrounding code is already changing.
- Branded or opaque types are most valuable for operational targets and boundary-crossing values: project/worktree IDs, session IDs, refs, paths, tokens, and similar domain primitives. Avoid branding every primitive if it makes local code harder to read without reducing risk.
- Commands are terminal commands. Do not force rigid command categories unless the product proves the need.
- Commands are non-persistent by default. Persistent commands are explicit.
- If a persistent command fails because of fixed ports or shared resources, surface the failure rather than magically fixing project configuration.
- Agent session resume should degrade gracefully when harnesses expose limited metadata.
- Waiting-for-user detection is product-critical, but the detection method may vary by harness.
- Restoration means recreating or reopening the environment when runtime process state is gone, not pretending child processes survived.

### Runtime Effect decisions

The mechanics are in ADR 0012 and [`effect-conventions.md`](../effect-conventions.md); these are the runtime decisions reviewers check most often.

- **Scope ownership.** A layer's scope is its service's lifetime. Anything a service starts that outlives one call (fibers, bus subscriptions, child processes, PubSubs, periodic loops) is attached to that scope with `Effect.acquireRelease`, `Effect.addFinalizer`, `Effect.forkScoped` or a `FiberSet`/`FiberMap`/`FiberHandle` made in the layer. `Effect.forkDetach` and `setTimeout`/`setInterval` are banned in the runtime; periodic work uses `runPeriodically` from `platform/fibers`. Shutdown interrupts request and socket fibers, then closes Fastify, then releases the service graph in reverse order along layer dependency edges only: a service is released before the services its layer depends on, so the platform goes last, but modules with no dependency edge between them (siblings in `Layer.mergeAll`) are released concurrently. A finalizer that needs another module still running must depend on that module's layer (`app/http-server.ts`).
- **Run sites.** The runtime runs Effects only at its process entry (`src/index.ts` through `runMain` in `app/run-main.ts`), its HTTP/WebSocket boundary (`app/http-server.ts` builds the server-scoped `RouteRuntime<R>`; `platform/http/route-runtime.ts` is where a request becomes a fiber; the PTY stream route and the runtime-events socket fork their connection fibers on it), and the workflow engine (`workflows/engine/author-bridge.ts` for the SDK Promise bridge, `workflows/engine/service.ts` for its work set). `scripts/architecture/effect-run-sites.json` is the allowlist; a run site anywhere else fails `pnpm lint`.
- **Logging levels.** Runtime code logs with `Effect.log*`; `no-console` is an error in runtime source (`apps/runtime/.oxlintrc.json`). `Debug` is what `ISAGI_RUNTIME_DEBUG` shows (phase traces, slow requests); `Info` is lifecycle milestones; `Warning` is degraded but handled (a loop tick failed, event-loop lag); `Error` is an unhandled defect at a boundary. `Debug`/`Info` go to stdout and `Warning`/`Error` to stderr through the one logger in `app/logger.ts`, provided outermost. Anything that may echo user data is logged through `describeOperationalCause` (`platform/diagnostics`), never raw. The `ISAGI_RUNTIME_READY` and `ISAGI_RUNTIME_STARTUP_FAILED` protocol lines are written directly, not logged.
- **Eager subscription.** `InternalEvents` and `RuntimeEvents` (`platform/events`) are PubSub buses whose `subscribe` returns a stream in the caller's scope: every event published after it returns is delivered. Consumers subscribe first, then fork the consumer. `Stream.fromPubSub` inside a forked fiber subscribes too late and loses events.
- **Typed API boundary.** Routes register with `registerApiEndpoint`/`registerContentEndpoint` from `platform/http`. A handler's error channel is `HandlerError<E>`: rejections built with `request.reject` from codes the endpoint declares, plus the platform infrastructure errors (`DatabaseError`, `DataDirectoryError`, `GitCommandError`, `ProjectPathValidationError`) the endpoint declares. Module failures are mapped with `catchTags` next to the endpoint, so an unmapped tag is a compile error. Defects are logged and answered `api_unhandled_error` by the helper, never by module code. No `unknown` error channels outside the author bridge.

## Severity Mapping

### Blocker

- Process, PTY, command, agent-session, background fiber, or resource lifecycle can silently orphan, leak, mis-associate, or misrepresent state.
- Long-lived resources or concurrent runtime systems lack explicit ownership, interruption, cleanup, or shutdown behavior.
- A fiber, subscription, child process, or loop outlives the scope that should own it: a detached fork, a timer outside Effect, or a hand-built scope in production code.
- An event-bus consumer subscribes lazily, so events published before it starts are lost.
- Logs echo secrets, environment values, prompt or agent output, or file contents.
- Internal operational code runs Effects so early that cancellation, retry, resource ownership, or composition is materially broken.
- A cross-boundary or user-impacting expected failure is modeled generically enough that clients cannot distinguish, recover from, or accurately present it.
- Description-only contracts or schemas expose implementation-layer Effect concepts.
- Runtime API responses expose domain, framework, or operational implementation errors instead of stable client-facing error shapes.
- Restoration failure is hidden or presented as success.
- Runtime errors that affect users lack any visible path to diagnosis.
- The UI becomes authoritative for runtime state that the runtime should own.
- Git/worktree facts are trusted from stale app state when they should be rediscovered.
- Failure or degradation behavior risks data loss, command execution in the wrong worktree, or misleading user action.

### Concern

- Operational modules mix Promise and Effect in a way that weakens composition, testability, cancellation, or failure handling.
- Effect is used ceremonially around pure logic where plain TypeScript would be easier to reason about.
- A growing integration lacks a service boundary or layer and is becoming hard to test, replace, or diagnose.
- An expected domain or operational failure is still generic/stringly in a way that creates real handling, diagnosability, or reviewability cost.
- Important operational targets use interchangeable primitive types where a mixup is plausible and consequential.
- Background work exists without clear cancellation, shutdown, or ownership semantics.
- Failure handling exists but does not expose enough context for support.
- Runtime API errors are explicit but too coarse for clients to handle important failure categories deliberately.
- Logs are present but too vague, noisy, or disconnected from user-visible errors.
- A log entry uses the wrong level, interpolates data into its message instead of annotating it, or logs an expected failure that the boundary also logs.
- A run site is added to the allowlist without a boundary reason, or a callback re-enters the runtime with `Effect.runPromise`.
- Lifecycle cleanup is plausible but not easy to verify.
- Runtime behavior handles the happy path but not likely degraded paths.
- A command or agent integration works for one harness while obscuring unsupported behavior elsewhere.

### Nit

- A helper could return an Effect directly instead of adding an extra boundary wrapper.
- A local pure helper does not need Effect.
- A tag, reason, or branded type name could be clearer.
- A log message could include a clearer operation or identifier.
- Error wording or error naming could be more specific.
- A small helper name could better reflect lifecycle intent.
- A test or manual verification note could mention one extra degraded path.
