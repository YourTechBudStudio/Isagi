# Runtime Persistence

## What this is

Persistence support for runtime-owned project, worktree, and worktree-environment state.

## Rules

- Runtime owns persistence and Git/worktree reconciliation.
- Use Drizzle ORM with SQLite through `better-sqlite3`; prefer Drizzle-supported drivers over hand-written SQL driver adapters.
- Use Drizzle Kit-generated migrations from the start.
- Do not edit generated migration artifacts by hand; change the Drizzle schema and regenerate migrations instead.
- Prefer incremental integer primary keys.
- Do not use composite primary keys. Use unique indexes for natural uniqueness such as project/worktree path constraints.
- Keep simple global resume pointers in `state.json`; durable worktree environment state belongs in the database.
- Treat Git and the filesystem as the source of truth for repository and worktree facts where practical, then reconcile persisted state against those facts.

## Effect scope

- Use Effect for persistence operations that perform IO, can fail, participate in startup/shutdown, or compose with runtime reconciliation.
- Keep pure schema definitions and local data-shaping helpers plain TypeScript.
