# 0005-disposable-pty-processes

status: accepted
date: 2026-06-15

## Decision

PTY records model disposable process incarnations. They are not durable product sessions, restoration identity, agent-session identity, terminal-session identity, or user-facing continuity units.

Isagi may use PTY backends such as node-pty or tmux to create an interactive terminal process, stream bytes, resize the terminal, replay available process logs, and terminate the process. Those backends are implementation details of the current process incarnation. They must not define whether a worktree environment, surface, pane, agent session, or future durable session is restorable.

The durable product model should refer to PTY process records as `pty_processes` or an equivalent process-oriented name. `pty_sessions` should not remain the domain name for this layer because "session" implies continuity that PTY processes do not own.

## Motivation

The tmux backend originally existed to keep terminal processes alive across runtime restarts. That tied Isagi's restoration story to external process survival. It also made PTY metadata look like durable session metadata, even though a machine restart, backend failure, or missing tmux server can still remove the actual process.

Isagi's product model is stronger if worktree environments are durable and processes are replaceable. A dead PTY process should mean only that the current transport is gone. It should not imply that the agent session, terminal surface, pane, or broader worktree environment has disappeared.

## Consequences

- Runtime process state and restoration state stay separate.
- A dead, missing, or killed PTY process does not by itself delete or invalidate a durable agent session, terminal session, surface, or pane.
- Runtime code may discard, replace, recreate, or garbage-collect PTY processes as operational state.
- PTY backend fields such as backend name, backend ref, process id, log path, and backend-specific status belong to process records and diagnostics.
- Runtime APIs and frontend surfaces should avoid exposing backend details as core product state. Backend facts may still be exposed when they are needed for diagnostics or support.
- Tmux and node-pty should be treated as backend implementations with the same product status: process transports, not restoration semantics.
- Startup reconciliation should mark stale process records honestly instead of pretending child processes survived.
- Tests and logs should describe PTY lifecycle in process terms: launch, attach, output, resize, exit, kill, cleanup, and garbage collection.

## Notes

This ADR does not require removing tmux immediately. It does require that tmux stop being the conceptual owner of resumability. If tmux remains available, it is a legacy or optional PTY backend behind the same disposable process abstraction.
