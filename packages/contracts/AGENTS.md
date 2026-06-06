# Contracts

## What this is

Shared versioned API contracts and schemas for Isagi clients and the runtime.

## Structure

- `src/` contains contract and schema source.
- `dist/` is generated build output.

## Effect scope

- Use `effect/Schema` through the `Schema` export from `effect` for serializable API schemas and inferred DTO types.
- Do not expose Effect errors, services, layers, fibers, runtime dependencies, domain implementation errors, or operational concepts from contracts.
- Keep schemas and contracts descriptive and implementation-free.

## API rules

- Runtime routes use the versioned `/api/v1` prefix.
- Success responses are enveloped as `{ data, meta: { requestId } }`.
- Error responses are enveloped as `{ error: { code, status, message, requestId, data? } }`.
- Use `camelCase` for JSON field names, including protocol metadata and structured error data.
- Use `snake_case` for string literal values such as error codes, error reasons, and enum-like protocol literals.
- Keep error codes descriptive enough to identify the subsystem and operation, but put nuanced causes in structured fields such as `data.reason` instead of exploding code variants.

## Rules

- Keep contracts implementation-free.
