import { defineConfig } from '@playwright/test';

const fixturePort = 41_731;

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
      name: 'rail-reorder',
      testMatch: /rail-reorder\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${fixturePort}/rail-reorder/` },
    },
  ],
});
