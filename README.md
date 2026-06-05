# Isagi

## Database migrations

Runtime SQLite migrations are generated with Drizzle Kit:

```sh
pnpm --filter @isagi/runtime exec drizzle-kit generate --config drizzle.config.ts
```

Edit `apps/runtime/src/persistence/schema.ts`, then regenerate. Do not hand-edit generated files in `apps/runtime/drizzle/`.
