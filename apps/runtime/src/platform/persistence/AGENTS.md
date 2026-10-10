# Runtime Persistence

## What this is

The runtime's domain-free persistence platform: the SQLite connection (`RuntimeDatabase`), the data directory (`DataDirectory`), migrations, the orphan-file collector helper (ADR 0010) and sibling-order compaction. Tables and repositories live in the modules that own them (ADR 0011).

## Rules

- Runtime owns persistence and Git/worktree reconciliation.
- Use Drizzle ORM with SQLite through `better-sqlite3`; prefer Drizzle-supported drivers over hand-written SQL driver adapters.
- Use Drizzle Kit-generated migrations from the start.
- Do not edit generated migration artifacts by hand; change the Drizzle schema and regenerate migrations instead with `pnpm -C apps/runtime db:generate`.
- Tables live in the owning module's `tables.ts`; only that module writes them; `drizzle.config.ts` globs `src/*/tables.ts`; `RuntimeDatabase` has no schema object.
- This area names no product concept and never imports a module.
- Prefer incremental integer primary keys.
- Do not use composite primary keys. Use unique indexes for natural uniqueness such as project/worktree path constraints.
- Worktree-dependent state must reference `worktrees.id` with `onDelete: 'cascade'` so deleting a worktree row removes its dependent environment state.
- Keep simple global resume pointers in `state.json`; durable worktree environment state belongs in the database.
- Treat Git and the filesystem as the source of truth for repository and worktree facts where practical, then reconcile persisted state against those facts.

## Effect scope

- Use Effect for persistence operations that perform IO, can fail, participate in startup/shutdown, or compose with runtime reconciliation.
- Keep pure schema definitions and local data-shaping helpers plain TypeScript.
- `RuntimeDatabase` and `DataDirectory` are platform services: module layers leave them open and `app/layer.ts` provides them once (`PlatformLayer`).
- The driver is synchronous: `use` and `transaction` callbacks run synchronously, so never `yield*`, `await` or run an Effect inside them. Fail a transaction with its typed `abort(error)`, not by throwing.
