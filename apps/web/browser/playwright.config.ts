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
  projects: [
    { name: 'dom-fallback', use: { baseURL: `http://127.0.0.1:${fixturePort}/?renderer=dom` } },
    { name: 'webgl-attempt', use: { baseURL: `http://127.0.0.1:${fixturePort}/?renderer=webgl` } },
  ],
});
