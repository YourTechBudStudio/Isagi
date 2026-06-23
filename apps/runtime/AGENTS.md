# Runtime

## What this is

The local-or-remote Isagi runtime. It will own Git, worktrees, PTYs, commands, agent sessions, and persistence over time.

## Structure

- `src/` contains the Fastify server, API route registration, and runtime implementation.
- `dist/` is generated build output.
- `drizzle/` contains Drizzle Kit-generated migration artifacts. Do not edit generated migration files by hand; change the Drizzle schema and regenerate migrations instead.

## Sessions and PTY processes

- Durable worktree entities (`agent_sessions`, `terminal_sessions`) sit above disposable PTY process incarnations (`pty_processes`). A durable session owns continuity and a sticky `active_pty_process_id`; the PTY process is transport only and is replaced freely. See ADRs 0005 and 0006.
- The PTY process layer (`src/pty-processes`) is generic: command, args, cwd, env, backend refs, logs, write/resize/kill, status. It must not import or branch on harness semantics. Harness adapters (`src/agent-sessions/harness/<harness>/adapter.ts`, registered via `src/agent-sessions/harness/registry.ts`) build the generic launch envelope.
- `node-pty` is the primary PTY backend. `tmux` is a legacy/optional PTY process backend only — it is one transport for a process incarnation, not a restoration or continuity mechanism. Restoration comes from durable sessions plus latest observed harness session ids, never from a backend's own session persistence.

## Effect scope

- Use Effect as the default substrate for operational work: Git, worktrees, commands, PTYs, agent harnesses, persistence, retries, config, diagnostics, and runtime services.
- Prefer Effect-returning internals; run Effects at Fastify, API, process, or script boundaries.
- Move toward services/layers as operational domains mature and need testable, replaceable dependencies.
- Use scoped resources, fibers, queues, streams, supervisors, interruption, and structured shutdown when managing long-lived processes, sessions, restoration, or concurrent runtime systems.
