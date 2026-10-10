# Contracts

## What this is

Shared versioned API contracts and schemas for Isagi clients and the runtime.

## Structure

- `src/` contains contract and schema source.
- `dist/` is generated build output.

## Effect scope

- Use Effect v4 Schema through the `Schema` export from `effect` for serializable API schemas and inferred DTO types. Import nothing from `effect` but `Schema` and `SchemaTransformation` (enforced by architecture rule E7).
- Write functional schemas: `export const xxxSchema = Schema.Struct({...})` with `export type Xxx = typeof xxxSchema.Type`. Use v4 idioms: `Schema.Literals([...])` for literal unions (Drizzle enums and the CLI read their `.literals`), `Schema.Union([...])`, `Schema.Record(key, value)`, `Schema.optionalKey(...)`, and `.check(Schema.isInt(), ...)` for refinements. No `Schema.Class`, no `Schema.TaggedError`.
- A `Schema.Unknown` property that can be absent is `Schema.optionalKey(Schema.Unknown)`: v4 rejects a missing key that v3 accepted.
- Endpoint descriptor slots are bounded by `WireSchema` (`Schema.Codec<unknown>`, a codec that needs no services).
- No branded ids in DTOs yet (see `effect-conventions.md` §13).
- Do not expose Effect errors, services, layers, fibers, runtime dependencies, domain implementation errors, or operational concepts from contracts.
- Keep schemas and contracts descriptive and implementation-free.
- `src/wire-goldens.test.ts` replays the frozen samples in `test/wire-goldens/wire-goldens.json` (captured on effect@3.21.2 before the v4 port, except entries that carry their own `capturedWith`) against every captured schema. A divergence is a wire change: fix the schema, or, when the change is deliberate and reviewed, recapture only the changed schemas with `pnpm -C packages/contracts exec tsx scripts/capture-wire-goldens.ts --only <name>[,<name>...]`. Names are export names or `endpoint:<domain>.<key>.<part>`; the tool lists other names that capture the same schema object so you can include them, merges the new entries into the file, stamps each with its own `capturedWith`, and writes nothing if a name does not resolve or cannot be sampled. The tool samples every member of a union (the v3 capture kept only the three smallest samples, usually one member), so recapture a union after adding an error code to it so the new member is pinned. List renamed or removed schemas in `test/wire-goldens/renames.json` or `removed.json` instead of recapturing them. Never recapture the whole file: v4's sampler differs from v3's, so the tool without `--only` only reports which entries a recapture would change (`--out <file>` writes that capture elsewhere for inspection).

## API rules

- Runtime routes use the versioned `/api/v1` prefix.
- Success responses are enveloped as `{ data, meta: { requestId } }`.
- Error responses are enveloped as `{ error: { code, status, message, requestId, data? } }`.
- Use `camelCase` for JSON field names, including protocol metadata and structured error data.
- Use `snake_case` for string literal values such as error codes, error reasons, and enum-like protocol literals.
- Keep error codes descriptive enough to identify the subsystem and operation, but put nuanced causes in structured fields such as `data.reason` instead of exploding code variants.

## Rules

- Keep contracts implementation-free.
