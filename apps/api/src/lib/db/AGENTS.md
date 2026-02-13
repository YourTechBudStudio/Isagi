# isagi api db

Owns Isagi API DB schema, migrations, and query helpers.

## Layout

- Schema entrypoint (runtime + DrizzleKit): `src/lib/db/schema.ts`
- Schema modules: `src/lib/db/schema.*.ts`
- DB client: `src/lib/db/client.ts`
- Repositories: `src/lib/db/*.repository.ts`
- Migrations (generated): `migrations/**`

## Schema

- Add tables in a domain module: `src/lib/db/schema.<domain>.ts`
- Export new modules from `src/lib/db/schema.ts` (single entrypoint)
- Keep DB access logic in `*.repository.ts` (handlers stay thin)

## Normalization preference

Prefer a normalized relational schema by default.

- Avoid redundant foreign keys when the relationship can be derived via joins.
  - Example: if `course_versions.variant_id -> course_variants.course_id`, avoid
    also storing `course_versions.course_id` unless there is a strong
    performance reason.
- If denormalization is chosen, document the rationale in code (what it
  unlocks and what consistency rules apply).

## Migrations (DrizzleKit)

- Config: `drizzle.config.ts` (local file db at `${ISAGI_ROOT}/isagi.db`, no auth tokens)
- Do not edit anything under `migrations/**` by hand
- The API runs migrations on startup, but you must still generate them

Commands:

- Generate migration plan: `pnpm --filter @isagi/api db:generate`
- Apply migrations manually: `pnpm --filter @isagi/api db:migrate`
- Studio: `pnpm --filter @isagi/api db:studio`

When schema changes, commit:

- `migrations/**` (including `migrations/meta/**`)
