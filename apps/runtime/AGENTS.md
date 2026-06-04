# Runtime

## What this is

The local-or-remote Isagi runtime. It will own Git, worktrees, PTYs, commands, agent sessions, and persistence over time.

## Structure

- `src/` contains the Fastify server and oRPC router implementation.
- `dist/` is generated build output.
- `drizzle/` contains Drizzle Kit-generated migration artifacts. Do not edit generated migration files by hand; change the Drizzle schema and regenerate migrations instead.

## Effect scope

- Use Effect as the default substrate for operational work: Git, worktrees, commands, PTYs, agent harnesses, persistence, retries, config, diagnostics, and runtime services.
- Prefer Effect-returning internals; run Effects at Fastify, oRPC, process, or script boundaries.
- Move toward services/layers as operational domains mature and need testable, replaceable dependencies.
- Use scoped resources, fibers, queues, streams, supervisors, interruption, and structured shutdown when managing long-lived processes, sessions, restoration, or concurrent runtime systems.
