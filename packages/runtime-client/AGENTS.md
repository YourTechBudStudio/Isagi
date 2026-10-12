# Runtime client

- Keep it a requester: no caching, no React, no filesystem, no product logic. Facades belong to their client (the web's `RuntimeApi`, the CLI's `runtime-api.ts`).
- Depend only on `effect` and the platform `fetch`, so the package runs in browsers, Node and Electron.
- Trace propagation is off on purpose: no tracing headers reach the runtime.
