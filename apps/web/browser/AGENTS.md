# Browser fixtures

- Commit only shared infrastructure and fixtures needed by maintained regression tests. Extend an existing fixture before adding a page.
- Keep disposable prototypes in `apps/web/browser/playground/` (gitignored), outside committed build inputs, test discovery, and production imports. Clean checkouts must work without them.
- Exercise production components with minimal simulated dependencies; real filesystem/runtime behavior belongs in runtime tests.
- Remove unused controls and obsolete previews.
- Run affected browser tests in the foreground; the runner owns its server. On port conflicts, choose a free port via `ISAGI_BROWSER_FIXTURE_PORT` and rerun, leaving other servers alone. Interactive servers are human-started/stopped.

## Commands

From the repository root; project names and fixture URLs are in [playwright.config.ts](playwright.config.ts).

```sh
node apps/web/browser/check-chromium.mjs
pnpm --filter @isagi/web exec playwright install chromium # Only if missing.
pnpm -C apps/web exec playwright test -c browser/playwright.config.ts --list
pnpm -C apps/web test:browser --project='<project>'
pnpm test:browser
ISAGI_BROWSER_FIXTURE_PORT=41732 pnpm test:browser # Override the default 41731.
```

For interactive review, a human runs `node apps/web/browser/fixture-server.mjs <port>` and stops it with Ctrl+C when finished. Open the fixture path on `http://127.0.0.1:<port>`.
