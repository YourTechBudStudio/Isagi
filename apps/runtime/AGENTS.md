# Runtime

## What this is

The local-or-remote Isagi runtime. It will own Git, worktrees, PTYs, commands, agent sessions, and persistence over time.

## Structure

- `src/` contains the Fastify server and oRPC router implementation.
- `dist/` is generated build output.
