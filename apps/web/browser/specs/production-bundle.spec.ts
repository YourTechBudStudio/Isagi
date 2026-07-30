import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from '@playwright/test';

test('production bundle excludes browser fixture and deleted gallery markers', async () => {
  const root = path.resolve(import.meta.dirname, '../../dist');
  const files = await collectFiles(root);
  const bundle = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');
  expect(bundle).not.toContain('data-browser-terminal-fixture');
  expect(bundle).not.toContain('/__dev/terminal-cache-states');
  expect(bundle).not.toContain('fixture-forced-dom-renderer');
  expect(bundle).not.toContain('ANSI_FIXTURE_SEED');
  // The update surface's fixture drives the component directly and simulates
  // the host. None of that may reach a shipped build.
  expect(bundle).not.toContain('data-state-option');
  expect(bundle).not.toContain('data-activity-option');
  expect(bundle).not.toContain('useSimulatedRestart');
});

async function collectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) => {
        const target = path.join(directory, entry.name);
        return entry.isDirectory() ? collectFiles(target) : [target];
      }),
    )
  ).flat();
}
