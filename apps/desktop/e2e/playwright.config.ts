import { defineConfig } from '@playwright/test';

/**
 * The desktop end-to-end suite: the unpackaged app (`electron .` after `stage:runtime` and the builds, which
 * `pnpm test:e2e` runs first) against the staged runtime, each test with a fresh data directory. One worker, so runs
 * never compete for the machine; no retries, so a flake shows.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: '../test-results/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 45_000 },
  reporter: [['list']],
});
