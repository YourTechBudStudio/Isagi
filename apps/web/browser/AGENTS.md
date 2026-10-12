# Browser fixtures

- Extend an existing fixture before adding a page; commit only fixtures that maintained regression tests need.
- Keep disposable prototypes in the gitignored `apps/web/browser/playground/`; clean checkouts must work without them.
- On a port conflict, pick a free port with `ISAGI_BROWSER_FIXTURE_PORT` and rerun, leaving other servers alone.
- Interactive fixture servers (`node apps/web/browser/fixture-server.mjs <port>`) are started and stopped by a human, never by an agent.
