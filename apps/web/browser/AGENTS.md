# Browser fixtures

- Commit only shared infrastructure and fixtures needed by maintained regression tests. Extend an existing fixture before adding a page.
- Keep disposable prototypes in `apps/web/browser/playground/` (gitignored), outside committed build inputs, test discovery and production imports; no tests are required for exploration. Clean checkouts must work without them.
- Exercise production components with minimal simulated dependencies; real filesystem and runtime behavior belongs in runtime tests.
- Remove unused controls and obsolete previews.
- Run affected browser tests in the foreground (`pnpm -C apps/web test:browser --project='<project>'`); the runner owns its server. On a port conflict, pick a free port with `ISAGI_BROWSER_FIXTURE_PORT` and rerun, leaving other servers alone.
- Interactive fixture servers (`node apps/web/browser/fixture-server.mjs <port>`) are started and stopped by a human, never by an agent.
