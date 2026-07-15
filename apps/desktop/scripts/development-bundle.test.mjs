import assert from 'node:assert/strict';
import { globSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { build } from 'vite';

test('desktop development bundle retains the Vite runtime URL key only for sanitization', async () => {
  const outDir = mkdtempSync(resolve(tmpdir(), 'isagi-desktop-bundle-'));
  try {
    await build({
      configFile: resolve(import.meta.dirname, '../vite.config.ts'),
      build: { outDir },
      logLevel: 'silent',
    });
    const bundle = globSync('**/*.js', { cwd: outDir })
      .map((path) => readFileSync(resolve(outDir, path), 'utf8'))
      .join('\n');
    assert.equal(bundle.match(/VITE_ISAGI_RUNTIME_URL/g)?.length, 1);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
