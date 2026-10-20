# 0012-runtime-interrupted-incarnations

status: accepted
date: 2026-10-20

## Decision

A process incarnation that ended because the runtime itself stopped is an interruption, not an outcome. Its durable entity comes back with a new incarnation and never presents the interrupted one as dead.

An incarnation is runtime-interrupted exactly when its PTY row is `killed` with `runtime_shutdown` (a graceful shutdown ended it) or `failed` with `runtime_ephemeral_lost` (a crash left a node-pty process for the next startup to record). `interruptedByRuntime` in `pty-processes` is the single definition; every domain reads it rather than re-spelling the reasons.

Each domain keeps its own relaunch path, and only the rule and its trigger are shared:

- Agent and terminal sessions come back eagerly at startup when pane-bound (`restorePaneBoundSessions`), and lazily on attach.
- A command interrupted by the runtime is `suspended`, not `failed`. Its run still closes as `failed` with `runtime_stopped`, so history stays honest. A run boot finds still open is classified from its linked PTY's own terminal facts through the same mapping the event path uses, so a process that exited or was lost by its backend just before shutdown keeps that outcome and is not resumed; only a run with no terminal facts to read counts as interrupted. The startup `worktree_activation_change` (`startup_restored`) resumes the active worktree's suspended commands through the same plan a worktree switch uses, then resumes `deactivate.stop: false` commands in every other worktree. Other suspended commands resume when their worktree is next active.
- An editor context whose incarnation was runtime-interrupted returns to idle at boot. Nothing launches then: Code Server starts only when its pane asks, and the pane's ordinary `reuse` launches a fresh incarnation exactly as a first open does. A mounted pane also issues `reuse` whenever the runtime events connection opens, so a pane that stays on screen through a runtime restart relaunches too; against a live or settled context `reuse` changes nothing.

Every other ending (an exit, a user kill, a failed launch, a missing tmux process) stays a visible outcome with the domain's existing recovery affordance.

## Motivation

ADR 0006 makes the durable entity the continuity unit and the process replaceable. Before this decision, the three entity kinds disagreed on what a runtime restart meant: sessions came back, the editor showed a dead Code Server until the user pressed Retry, and commands were marked failed with "Not restarted". A runtime restart says nothing about the work a process was doing, so presenting it as that work's failure is dishonest, and asking the user to repair what the runtime broke is friction with no decision in it.

Sharing the rule rather than the relaunch code keeps each domain's ownership intact (ADR 0008): commands own runs, ports and activation; the editor owns its attempt record, endpoint and readiness probe; sessions own harness resume.

## Consequences

- A new entity kind with a process incarnation applies `interruptedByRuntime` and decides only when to relaunch, not whether.
- Eager versus lazy restoration is per kind and follows the entity's cost: sessions are eager, the editor is pane-driven, and commands follow worktree activation.
- `startup_restored` is always published, with a null worktree when none is active, so startup work not tied to the active worktree can ride it.
- Agent and terminal session status derivation still distinguishes the two reasons, because it reports different diagnostics for them; it does not need the shared predicate.
