import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
    ISAGI_EDITOR_CAPABILITY: 'code_server',
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
      ISAGI_EDITOR_CAPABILITY: 'code_server',
      ISAGI_DATA_DIR: '/data/.isagi',
    },
  );
});

/**
 * The declaration is the desktop's own promise about the runtime it spawned.
 * An operator's inherited value must never be able to make that promise, nor
 * to shadow it with something the runtime would not recognize.
 */
test('an inherited capability cannot survive or shadow the managed declaration', () => {
  for (const inheritedCapability of ['code_server', 'vscode', '']) {
    const environment = managedRuntimeSpawnEnvironment({
      inherited: { ISAGI_EDITOR_CAPABILITY: inheritedCapability },
      allowedOrigins: 'file://',
      dataDirectory: undefined,
    });
    assert.equal(environment.ISAGI_EDITOR_CAPABILITY, 'code_server', inheritedCapability);
  }
  // Sanitization removes it outright, so the declaration is the only source.
  assert.equal(
    'ISAGI_EDITOR_CAPABILITY' in
      sanitizeManagedRuntimeEnvironment({ ISAGI_EDITOR_CAPABILITY: 'vscode' }),
    false,
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

/**
 * `runtime.ts` cannot be imported here — it requires Electron's `app` — so the
 * boundary is verified structurally. An externally attached runtime is not
 * spawned by the desktop at all, which is what makes "external runtimes are
 * never editor-capable" a property of the wiring rather than of a check.
 */
test('only the managed target assembles a spawn environment', async () => {
  const source = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), 'runtime.ts'),
    'utf8',
  );

  assert.equal(source.match(/managedRuntimeSpawnEnvironment\(/gu)?.length, 1);
  assert.ok(
    source.indexOf('managedRuntimeSpawnEnvironment({') >
      source.indexOf('function prepareManagedRuntime'),
    'the only assembler call must live inside prepareManagedRuntime',
  );

  // The external target carries a URL and nothing else: no prepare, no env.
  const externalTarget = source.slice(
    source.indexOf("{ ownership: 'external'"),
    source.indexOf("{ ownership: 'managed'"),
  );
  assert.doesNotMatch(externalTarget, /env|prepare|CAPABILITY/u);
});
