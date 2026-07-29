import { access } from 'node:fs/promises';

import { chromium } from '@playwright/test';

try {
  await access(chromium.executablePath());
} catch {
  console.error('Playwright Chromium is required. Install the pinned browser explicitly:');
  console.error('pnpm --filter @isagi/web exec playwright install chromium');
  process.exitCode = 1;
}
