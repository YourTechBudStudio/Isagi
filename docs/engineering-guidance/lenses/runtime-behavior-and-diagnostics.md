# Runtime Behavior And Diagnostics

## What This Lens Protects

Operational truth: lifecycle clarity, failure semantics, cancellation, resource ownership, diagnosability and early-user supportability. Isagi launches and manages worktrees, commands, PTYs, agent sessions, surfaces and restoration. When these fail, the user should understand what happened and the maintainer should be able to diagnose it.

This lens reviews operational work once it exists. Whether that work is attached to the right trigger belongs to `state-flow-and-operational-cost.md`. How Isagi uses Effect for this work is ADR 0011.

## Review Questions

- Is runtime state owned by the runtime, and are Git and filesystem facts rediscovered from their real source where practical?
- Is lifecycle ownership clear for processes, PTYs, commands, agent sessions, background work and persisted state? Can the change orphan, leak, mis-associate or misrepresent any of them?
- Does operational code follow ADR 0011: effects run only at boundaries, and everything a service starts that outlives a call (fibers, subscriptions, child processes, loops) is owned by its layer scope so shutdown releases it?
- Are interruption, shutdown and cleanup explicit for long-lived processes, streams, sessions and supervisors? Can a client disconnect cut a must-finish sequence in half?
- Do third-party callbacks reach operational code through the edge that owns the integration, rather than starting work ad hoc?
- Are expected failures tagged and structured, distinct from defects, and mapped at the API boundary to errors the endpoint's contract declares?
- Can clients and users tell apart validation, domain, internal and degraded-runtime failures where they need different handling?
- Are failures surfaced instead of swallowed, and does degraded behavior stay honest about what did and did not work?
- Is each log entry at the right level, with a static message, identifiers as annotations, and user data only through its safe description?
- Could a user report enough for remote debugging, without logs or payloads dumping noise or sensitive data?
- Are command failures, integration limits and restoration failures visible where they matter?
- Does verification cover the risky lifecycle paths, not only the happy path?

## Isagi-Specific Notes

- Commands are terminal commands. Do not force rigid command categories unless the product proves the need.
- Commands are non-persistent by default; persistent commands are explicit. If one fails because of fixed ports or shared resources, surface the failure rather than silently fixing project configuration.
- Agent session resume degrades gracefully when a harness exposes little metadata. Waiting-for-user detection is product-critical, but its method may vary by harness.
- Restoration means recreating or reopening the environment when process state is gone, never pretending child processes survived.
- New or touched expected failures should be tagged and structured; improve existing generic errors when the surrounding code is already changing.

## Severity Mapping

### Blocker

- Process, PTY, command, agent-session, background or resource lifecycle can silently orphan, leak, mis-associate or misrepresent state.
- Long-lived work lacks explicit ownership, interruption, cleanup or shutdown, or outlives the scope that should own it (a detached fork, a timer outside that scope, a hand-built scope in production code).
- Effects run so early or so deep that cancellation, retry, resource ownership or composition is broken.
- Logs echo secrets, environment values, prompt or agent output, or file contents.
- An expected cross-boundary or user-impacting failure is too generic for clients to distinguish, recover from or present accurately, or API responses expose implementation errors instead of stable error shapes.
- Restoration failure is hidden or presented as success, or a user-affecting runtime error has no path to diagnosis.
- The UI becomes authoritative for runtime state, or Git/worktree facts are trusted from stale app state.
- Failure or degradation risks data loss, running a command in the wrong worktree, or misleading user action.

### Concern

- Promise and Effect are mixed in a way that weakens composition, testability, cancellation or failure handling.
- Effect is used ceremonially around pure logic.
- A growing integration lacks a service boundary and is becoming hard to test, replace or diagnose.
- An expected failure is still generic or stringly where that has real handling or diagnosis cost.
- Background work has unclear cancellation, shutdown or ownership.
- Failure handling exists but lacks context for support, or API errors are too coarse for important failure categories.
- Logs are vague, noisy or disconnected from user-visible errors; an entry uses the wrong level, interpolates data into its message, or logs a failure the boundary logs again.
- A new place runs effects without a boundary reason, or a callback re-enters the runtime directly.
- Cleanup is plausible but hard to verify, or only the happy path is handled.
- An integration works for one harness while hiding unsupported behavior elsewhere.

### Nit

- A helper could return an effect directly instead of adding a wrapper, or a local pure helper does not need Effect.
- A tag, reason, error or helper name could be clearer.
- A log message could name the operation or identifier more clearly.
- A verification note could mention one more degraded path.
