import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { appearanceSettingsDefaults } from '../contracts/index.js';
import {
  globalConfigPath,
  parseAppearance,
  readGlobalConfig,
  resolveDataDirectory,
} from './index.js';

function withDirectory(run: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'isagi-global-config-'));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('a data directory without config.yaml reads as missing', () => {
  withDirectory((directory) => {
    assert.deepEqual(readGlobalConfig(directory), { status: 'missing' });
  });
});

test('config.yaml reads as its document and plain value', () => {
  withDirectory((directory) => {
    writeFileSync(globalConfigPath(directory), 'appearance:\n  theme: dark\n', 'utf8');
    const read = readGlobalConfig(directory);
    assert.equal(read.status, 'loaded');
    if (read.status !== 'loaded') return;
    assert.deepEqual(read.value, { appearance: { theme: 'dark' } });
    assert.equal(read.bytes, 'appearance:\n  theme: dark\n');
  });
});

test('invalid YAML fails with its code and position, never its text', () => {
  withDirectory((directory) => {
    writeFileSync(globalConfigPath(directory), 'appearance: [secret-value\n', 'utf8');
    const read = readGlobalConfig(directory);
    assert.equal(read.status, 'failed');
    if (read.status !== 'failed') return;
    assert.equal(read.failure.reason, 'yaml_syntax');
    assert.equal(JSON.stringify(read.failure).includes('secret-value'), false);
  });
});

test(
  'an unreadable config.yaml fails with its system error code',
  { skip: process.getuid?.() === 0 },
  () => {
    withDirectory((directory) => {
      const path = globalConfigPath(directory);
      writeFileSync(path, 'pty: {}\n', 'utf8');
      chmodSync(path, 0o000);
      assert.deepEqual(readGlobalConfig(directory), {
        status: 'failed',
        failure: { reason: 'read_failed', systemErrorCode: 'EACCES' },
      });
    });
  },
);

test('appearance defaults when missing, decodes a theme and reports an invalid one by path', () => {
  assert.deepEqual(parseAppearance({}), {
    status: 'decoded',
    appearance: appearanceSettingsDefaults,
  });
  assert.deepEqual(parseAppearance({ appearance: { theme: 'dark' } }), {
    status: 'decoded',
    appearance: { theme: 'dark' },
  });
  assert.deepEqual(parseAppearance({ appearance: { theme: 'neon' } }), {
    status: 'invalid',
    issuePaths: ['appearance.theme'],
  });
});

test('the data directory comes from ISAGI_DATA_DIR, else the default, with ~ expanded', () => {
  const home = '/home/example';
  assert.equal(resolveDataDirectory({ env: {}, home }), '/home/example/.isagi');
  assert.equal(resolveDataDirectory({ env: { ISAGI_DATA_DIR: '' }, home }), '/home/example/.isagi');
  assert.equal(resolveDataDirectory({ env: { ISAGI_DATA_DIR: '~/x' }, home }), '/home/example/x');
  assert.equal(resolveDataDirectory({ env: { ISAGI_DATA_DIR: '/data' }, home }), '/data');
});
