# Runtime client

## What this is

The one HTTP requester every Isagi client uses to call the runtime API: the web app, the `isagi` CLI and desktop main. It decodes the `{ data }` / `{ error }` envelopes against the endpoint descriptors in `@isagi/contracts`, so every client sees the same success values and the same three failures, `Data.TaggedError`s `RuntimeApiError`, `RuntimeTransportError` and `RuntimeDecodeError`.

## Structure

- `src/service.ts`: the `RuntimeClient` service (`isagi/runtime-client/RuntimeClient`; `runtimeUrl`, `request`, `requestContent`), `RuntimeClient.layer(url)` and `RuntimeClient.make(url)` for a URL known only at run time, and `RuntimeHttpClient`, the platform `fetch` as an `effect/http` `HttpClient` that looks `globalThis.fetch` up per request.
- `src/requester.ts`: the JSON and content requesters. Content routes return `RuntimeContent` (`contentType`, a byte `stream`, or the whole body as `arrayBuffer`).
- `src/errors.ts`: the three failures.

## Rules

- Use only Effect (`effect`, `effect/http` `FetchHttpClient`), `URL` and the platform `fetch`, so the package runs in browsers, Node and Electron-as-Node. Trace propagation stays off (`HttpClient.TracerPropagationEnabled` is `false`): no tracing headers reach the runtime.
- Consumers provide `RuntimeHttpClient` once at their boundary; tests provide `FetchHttpClient.layer` with a fake `FetchHttpClient.Fetch` or swap `globalThis.fetch`.
- Keep it a requester: no caching, no React, no filesystem, no product logic. Facades belong to their client (`apps/web/src/lib/runtime/client.ts` `RuntimeApi`, `apps/cli/src/runtime-api.ts`).
- Exports TypeScript source, like `@isagi/contracts`.
