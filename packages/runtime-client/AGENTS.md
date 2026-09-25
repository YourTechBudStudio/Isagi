# Runtime client

## What this is

The one HTTP requester every Isagi client uses to call the runtime API: the web app and the `isagi` CLI. It decodes the `{ data }` / `{ error }` envelopes against the endpoint descriptors in `@isagi/contracts`, so every client sees the same success values and the same three failures (`RuntimeApiError`, `RuntimeTransportError`, `RuntimeDecodeError`).

## Rules

- Use only `fetch`, `URL`, `Response` and Effect, so the package runs in browsers, Node and Electron-as-Node.
- Keep it a requester: no caching, no React, no filesystem, no product logic. Facades belong to their client (`apps/web/src/lib/runtime/client.ts`, `apps/cli/src/runtime-api.ts`).
- Exports TypeScript source, like `@isagi/contracts`.
