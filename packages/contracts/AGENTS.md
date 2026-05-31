# Contracts

## What this is

Shared oRPC contracts and schemas for Isagi clients and the runtime.

## Structure

- `src/` contains contract and schema source.
- `dist/` is generated build output.

## Effect scope

- Do not import Effect in this package.
- Do not expose Effect errors, services, layers, runtime dependencies, or implementation concepts from contracts.
- Keep schemas and contracts descriptive and implementation-free.

## Rules

- Keep contracts implementation-free.
