# Runtime Behavior And Diagnostics

## What This Lens Protects

This lens protects runtime truth, lifecycle clarity, failure semantics, diagnosability, and early-user supportability.

Isagi will launch and manage Git worktrees, commands, PTYs, agent sessions, surfaces, runtime state, and restoration behavior. When these fail, the product should make the failure understandable to the user and diagnosable by the maintainer.

## Review Questions

- Is runtime state owned by the runtime rather than inferred or over-owned by the UI?
- Are Git and filesystem facts rediscovered from their real source where practical?
- Is lifecycle ownership clear for processes, PTYs, commands, agent sessions, and persisted state?
- Can the behavior orphan, leak, mis-associate, or misrepresent runtime state?
- Are failures surfaced instead of silently swallowed?
- Does degraded behavior remain honest about what did and did not work?
- Would a user be able to report enough information for remote debugging?
- Do logs or error payloads include useful context without dumping noise or sensitive data unnecessarily?
- Are command failures, integration limitations, and restoration failures visible where they matter?
- Does verification cover the risky lifecycle paths, not only the happy path?

## Isagi-Specific Notes

- Commands are terminal commands. Do not force rigid command categories unless the product proves the need.
- Commands are non-persistent by default. Persistent commands are explicit.
- If a persistent command fails because of fixed ports or shared resources, surface the failure rather than magically fixing project configuration.
- Agent session resume should degrade gracefully when harnesses expose limited metadata.
- Waiting-for-user detection is product-critical, but the detection method may vary by harness.
- Restoration means recreating or reopening the environment when runtime process state is gone, not pretending child processes survived.

## Severity Mapping

### Blocker

- Process, PTY, command, or agent-session lifecycle can silently orphan, leak, mis-associate, or misrepresent state.
- Restoration failure is hidden or presented as success.
- Runtime errors that affect users lack any visible path to diagnosis.
- The UI becomes authoritative for runtime state that the runtime should own.
- Git/worktree facts are trusted from stale app state when they should be rediscovered.
- Failure or degradation behavior risks data loss, command execution in the wrong worktree, or misleading user action.

### Concern

- Failure handling exists but does not expose enough context for support.
- Logs are present but too vague, noisy, or disconnected from user-visible errors.
- Lifecycle cleanup is plausible but not easy to verify.
- Runtime behavior handles the happy path but not likely degraded paths.
- A command or agent integration works for one harness while obscuring unsupported behavior elsewhere.

### Nit

- A log message could include a clearer operation or identifier.
- Error wording could be more specific.
- A small helper name could better reflect lifecycle intent.
- A test or manual verification note could mention one extra degraded path.
