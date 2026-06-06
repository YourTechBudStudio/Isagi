# Runtime Behavior, Effects, And Diagnostics

## What This Lens Protects

This lens protects operational truth: lifecycle clarity, Effect usage, failure semantics, diagnosability, cancellation, resource ownership, and early-user supportability.

Isagi will launch and manage Git worktrees, commands, PTYs, agent sessions, surfaces, runtime state, and restoration behavior. When these fail, the product should make the failure understandable to the user and diagnosable by the maintainer.

Effect is the substrate for this operational work. That does not mean Effect everywhere; it means async work, failure, retries, dependencies, cancellation, long-lived resources, and shutdown behavior should be explicit where they matter.

## Review Questions

- Is runtime state owned by the runtime rather than inferred or over-owned by the UI?
- Are Git and filesystem facts rediscovered from their real source where practical?
- Is lifecycle ownership clear for processes, PTYs, commands, agent sessions, background fibers, and persisted state?
- Can the behavior orphan, leak, mis-associate, or misrepresent runtime state?
- Does operational code compose Effects internally and run them at framework or process boundaries?
- Are `Effect.runPromise`, `Effect.runSync`, or `Effect.runFork` used deliberately at boundaries rather than deep inside reusable operational modules?
- Is the code at the right Effect maturity tier for its complexity: local Effect, service/layer, or scoped concurrent system?
- Are scoped resources, interruption, shutdown, and cleanup explicit for long-lived processes, streams, queues, sessions, and supervisors?
- Are failures surfaced instead of silently swallowed?
- Are domain failures mapped into explicit API errors at runtime boundaries rather than leaking implementation errors?
- Are validation failures, domain failures, internal failures, and degraded-runtime behavior distinguishable where clients or users need different handling?
- Does degraded behavior remain honest about what did and did not work?
- Would a user be able to report enough information for remote debugging?
- Do logs or error payloads include useful context without dumping noise or sensitive data unnecessarily?
- Are command failures, integration limitations, and restoration failures visible where they matter?
- Does verification cover the risky lifecycle paths, not only the happy path?

## Isagi-Specific Notes

- Package-scoped `AGENTS.md` files define the local Effect scope for each package. Keep this lens focused on operational review questions rather than package policy.
- Isagi aims for Tier 2 by default in operational code and Tier 3 when lifecycle complexity justifies scopes, fibers, queues, streams, supervisors, or structured shutdown.
- Commands are terminal commands. Do not force rigid command categories unless the product proves the need.
- Commands are non-persistent by default. Persistent commands are explicit.
- If a persistent command fails because of fixed ports or shared resources, surface the failure rather than magically fixing project configuration.
- Agent session resume should degrade gracefully when harnesses expose limited metadata.
- Waiting-for-user detection is product-critical, but the detection method may vary by harness.
- Restoration means recreating or reopening the environment when runtime process state is gone, not pretending child processes survived.

## Severity Mapping

### Blocker

- Process, PTY, command, agent-session, background fiber, or resource lifecycle can silently orphan, leak, mis-associate, or misrepresent state.
- Long-lived resources or concurrent runtime systems lack explicit ownership, interruption, cleanup, or shutdown behavior.
- Internal operational code runs Effects so early that cancellation, retry, resource ownership, or composition is materially broken.
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
- Background work exists without clear cancellation, shutdown, or ownership semantics.
- Failure handling exists but does not expose enough context for support.
- Runtime API errors are explicit but too coarse for clients to handle important failure categories deliberately.
- Logs are present but too vague, noisy, or disconnected from user-visible errors.
- Lifecycle cleanup is plausible but not easy to verify.
- Runtime behavior handles the happy path but not likely degraded paths.
- A command or agent integration works for one harness while obscuring unsupported behavior elsewhere.

### Nit

- A helper could return an Effect directly instead of adding an extra boundary wrapper.
- A local pure helper does not need Effect.
- A log message could include a clearer operation or identifier.
- Error wording or error naming could be more specific.
- A small helper name could better reflect lifecycle intent.
- A test or manual verification note could mention one extra degraded path.
