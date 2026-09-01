import assert from 'node:assert/strict';
import test from 'node:test';

import {
  managedRuntimeSpawnEnvironment,
  sanitizeManagedRuntimeEnvironment,
} from './managed-runtime-environment.js';

test('managed runtime environment retains host tooling and removes private orchestration values', () => {
  const sanitized = sanitizeManagedRuntimeEnvironment({
    PATH: '/usr/bin',
    HOME: '/home/developer',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    HARNESS_TOKEN: 'secret',
    ISAGI_RUNTIME_DEBUG: '1',
    ISAGI_DEV_PROCESS_OWNER: '1',
    ISAGI_DEV_WORKTREE_ROOT: '/checkout',
    ISAGI_DESKTOP_LOG_MODE: 'supervisor',
    ISAGI_WEB_URL: 'http://127.0.0.1:4173',
    VITE_ISAGI_RUNTIME_URL: 'http://stale.invalid',
    ISAGI_ALLOWED_ORIGINS: 'http://stale.invalid',
    ISAGI_DATA_DIR: '/tmp/stale-data',
  });
  assert.deepEqual(sanitized, {
    PATH: '/usr/bin',
    HOME: '/home/developer',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    HARNESS_TOKEN: 'secret',
    ISAGI_RUNTIME_DEBUG: '1',
  });
});

test('the spawn environment declares the desktop-owned values over the inherited ones', () => {
  assert.deepEqual(
    managedRuntimeSpawnEnvironment({
      inherited: {
        PATH: '/usr/bin',
        ISAGI_ALLOWED_ORIGINS: 'http://stale.invalid',
        ISAGI_DATA_DIR: '/tmp/stale-data',
        ISAGI_WEB_URL: 'http://127.0.0.1:4173',
        HOST: 'stale.invalid',
        PORT: '9999',
      },
      allowedOrigins: 'file://',
      dataDirectory: '/data/.isagi',
    }),
    {
      PATH: '/usr/bin',
      ELECTRON_RUN_AS_NODE: '1',
      HOST: '127.0.0.1',
      PORT: '0',
      ISAGI_ALLOWED_ORIGINS: 'file://',
      ISAGI_DATA_DIR: '/data/.isagi',
    },
  );
});

test('an absent data directory is omitted rather than declared empty', () => {
  const environment = managedRuntimeSpawnEnvironment({
    inherited: { ISAGI_DATA_DIR: '/tmp/stale-data' },
    allowedOrigins: 'file://',
    dataDirectory: undefined,
  });
  assert.equal('ISAGI_DATA_DIR' in environment, false);
});
