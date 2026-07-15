import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeManagedRuntimeEnvironment } from './development-environment.js';

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
    ISAGI_RUNTIME_STAGE_GATE: 'supervisor',
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
