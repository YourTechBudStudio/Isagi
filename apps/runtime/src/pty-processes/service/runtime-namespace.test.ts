import assert from 'node:assert/strict';
import { delimiter, dirname } from 'node:path';
import test from 'node:test';

import { launchEnv, userShellBaseEnv } from './runtime-namespace.js';

const nodeBin = dirname(process.execPath);

test('launch env prepends the runtime node bin when PATH lacks it', () => {
  const entries = (launchEnv({ PATH: ['/usr/bin', '/bin'].join(delimiter) }).PATH ?? '').split(
    delimiter,
  );
  assert.deepEqual(entries, [nodeBin, '/usr/bin', '/bin']);
});

test('launch env keeps the runtime node bin present without duplicating it', () => {
  const entries = (
    launchEnv({ PATH: ['/usr/bin', nodeBin, '/bin'].join(delimiter) }).PATH ?? ''
  ).split(delimiter);
  // Already-present node bin stays in place rather than being prepended again.
  assert.deepEqual(entries, ['/usr/bin', nodeBin, '/bin']);
});

test('launch env falls back to just the runtime node bin when PATH is unset', () => {
  assert.equal(launchEnv({}).PATH, nodeBin);
});

test('user process environment removes runtime-owned controls without losing user identity', () => {
  const environment = userShellBaseEnv({
    USER: 'yourtechbud',
    HOME: '/Users/yourtechbud',
    SHELL: '/bin/zsh',
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    HOST: '127.0.0.1',
    PORT: '0',
    ELECTRON_RUN_AS_NODE: '1',
    ISAGI_ALLOWED_ORIGINS: 'file://',
    ISAGI_DATA_DIR: '/runtime/data',
    ISAGI_RUNTIME_DEBUG: '1',
    VITE_ISAGI_RUNTIME_URL: 'http://127.0.0.1:1234',
  });

  assert.deepEqual(environment, {
    USER: 'yourtechbud',
    HOME: '/Users/yourtechbud',
    SHELL: '/bin/zsh',
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  });
});
