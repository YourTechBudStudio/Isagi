# Isagi API

The Isagi API is the local, single-user backend for capture, triage, and
artifact storage.

## Integration Notes

- API contracts live in `@isagi/contract/api`.
- Always consume contract types instead of duplicating request/response shapes.
- Data root is resolved from `--root` or `ISAGI_ROOT`, defaulting to
  `~/.isagi/data`.
- Local database file lives at `${ISAGI_ROOT}/isagi.db` (no auth tokens).

## Project Structure

- `apps/api/src/main.ts`: Express entrypoint, oRPC mounting, migrations
- `apps/api/src/router.ts`: Top-level oRPC router composition
- `apps/api/src/modules/*`: Feature modules (router + handlers)
- `apps/api/src/lib/config.ts`: Runtime env parsing/validation
- `apps/api/src/lib/db/*`: Schema + client + migrations (see `src/lib/db/AGENTS.md`)
- `apps/api/migrations/*`: Drizzle Kit migrations (generated)

The API runs Drizzle Kit migrations on startup; schema changes still require
`db:generate` and committed migration files.

## oRPC Handler Rule

Always wrap oRPC handlers in `try/catch` to ensure errors are logged with
context. Re-throw `ORPCError` instances as-is, and wrap unknown errors with a
safe `ORPCError("INTERNAL_SERVER_ERROR", ...)`. Log metadata like IDs and
paths, but never log secrets, bearer tokens, or full spark text.

## Dev Commands

```bash
pnpm --filter @isagi/api dev
pnpm --filter @isagi/api build
pnpm --filter @isagi/api lint
```
