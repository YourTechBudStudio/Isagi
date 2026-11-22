import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readDesktopTheme } from './desktop-theme.js';

function withConfig(contents: string | undefined, check: (dataDirectory: string) => void) {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'isagi-desktop-theme-'));
  try {
    if (contents !== undefined) writeFileSync(join(dataDirectory, 'config.yaml'), contents);
    check(dataDirectory);
  } finally {
    rmSync(dataDirectory, { recursive: true, force: true });
  }
}

test('the configured theme is read from config.yaml', () => {
  withConfig('appearance:\n  theme: dark\n', (dir) => assert.equal(readDesktopTheme(dir), 'dark'));
  withConfig('appearance:\n  theme: light\n', (dir) =>
    assert.equal(readDesktopTheme(dir), 'light'),
  );
});

test('a missing, malformed or invalid config paints the default theme', () => {
  withConfig(undefined, (dir) => assert.equal(readDesktopTheme(dir), 'light'));
  withConfig('appearance: [unclosed\n', (dir) => assert.equal(readDesktopTheme(dir), 'light'));
  withConfig('appearance:\n  theme: system\n', (dir) =>
    assert.equal(readDesktopTheme(dir), 'light'),
  );
  withConfig('server:\n  port: 11299\n', (dir) => assert.equal(readDesktopTheme(dir), 'light'));
  assert.equal(
    readDesktopTheme('/unused', () => ({
      status: 'failed',
      failure: { reason: 'read_failed', systemErrorCode: 'EACCES' },
    })),
    'light',
  );
});
