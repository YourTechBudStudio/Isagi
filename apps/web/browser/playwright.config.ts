import { defineConfig } from '@playwright/test';

const fixturePort = Number(process.env.ISAGI_BROWSER_FIXTURE_PORT ?? 41_731);
if (!Number.isSafeInteger(fixturePort) || fixturePort < 1 || fixturePort > 65_535) {
  throw new RangeError('ISAGI_BROWSER_FIXTURE_PORT must be an integer from 1 to 65535');
}

export default defineConfig({
  testDir: './specs',
  outputDir: '../test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: '../playwright-report', open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${fixturePort}`,
    browserName: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `node fixture-server.mjs ${fixturePort}`,
    url: `http://127.0.0.1:${fixturePort}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  // The fixture bundle is multi-entry, so each project points at the page its
  // specs belong to. Without the `testMatch` filters every spec would run under
  // every project — the terminal specs twice over on the update page, and back.
  projects: [
    {
      name: 'dom-fallback',
      testMatch: /(terminal-.*|production-bundle)\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${fixturePort}/?renderer=dom` },
    },
    {
      name: 'webgl-attempt',
      testMatch: /terminal-.*\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${fixturePort}/?renderer=webgl` },
    },
    {
      name: 'update-surface',
      testMatch: /update-surface\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${fixturePort}/update/` },
    },
    {
      name: 'editor-pane',
      testMatch: /editor-pane\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${fixturePort}/test-support/editor/` },
    },
    {
      name: 'rail-reorder',
      testMatch: /rail-reorder\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${fixturePort}/rail-reorder/` },
    },
    // Shares the rail page: the worktree menu is chrome on the same production
    // rail, and its own project keeps each spec file matched by exactly one.
    {
      name: 'rail-worktree-actions',
      testMatch: /rail-worktree-actions\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${fixturePort}/rail-reorder/` },
    },
    // Both palette spec files share this page and this project. The alternation is
    // anchored so each file is matched exactly once and `command-endpoints.spec.ts`
    // — which needs a clipboard permission the rest should not have — keeps its own.
    {
      name: 'command-palette',
      testMatch: /command-palette(-path)?\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${fixturePort}/command-palette/` },
    },
    // Shares the command-palette page, because the endpoint surfaces are the
    // strip and the drawer that page already mounts. Its own project so the
    // clipboard permission it needs is not granted to every other spec.
    {
      name: 'command-endpoints',
      testMatch: /command-endpoints\.spec\.ts/,
      use: {
        baseURL: `http://127.0.0.1:${fixturePort}/command-palette/`,
        permissions: ['clipboard-read', 'clipboard-write'],
      },
    },
  ],
});
