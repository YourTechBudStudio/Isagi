import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  managedRuntimeServeArguments,
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
  });
  assert.deepEqual(sanitized, {
    PATH: '/usr/bin',
    HOME: '/home/developer',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    HARNESS_TOKEN: 'secret',
    ISAGI_RUNTIME_DEBUG: '1',
  });
});

test('the spawn environment adds only ELECTRON_RUN_AS_NODE; serve settings travel as flags', () => {
  assert.deepEqual(
    managedRuntimeSpawnEnvironment({
      inherited: { PATH: '/usr/bin', ISAGI_WEB_URL: 'http://127.0.0.1:4173' },
    }),
    { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' },
  );
  const environment = managedRuntimeSpawnEnvironment({ inherited: {} });
  for (const name of [
    'HOST',
    'PORT',
    'ISAGI_EDITOR_CAPABILITY',
    'ISAGI_ALLOWED_ORIGINS',
    'ISAGI_DATA_DIR',
  ]) {
    assert.equal(name in environment, false, name);
  }
});

test("the user's ISAGI_HOST and ISAGI_PORT reach serve, which applies them by precedence", () => {
  const environment = managedRuntimeSpawnEnvironment({
    inherited: { ISAGI_HOST: '0.0.0.0', ISAGI_PORT: '11299' },
  });
  assert.equal(environment.ISAGI_HOST, '0.0.0.0');
  assert.equal(environment.ISAGI_PORT, '11299');
});

test('serve arguments carry the origins, the web root and, when the desktop chose one, the data directory', () => {
  assert.deepEqual(
    managedRuntimeServeArguments({
      allowedOrigins: 'file://',
      dataDirectory: undefined,
      webRoot: '/Applications/Isagi.app/Contents/Resources/web',
    }),
    [
      'serve',
      '--allowed-origins',
      'file://',
      '--web-root',
      '/Applications/Isagi.app/Contents/Resources/web',
    ],
  );
  assert.deepEqual(
    managedRuntimeServeArguments({
      allowedOrigins: 'http://127.0.0.1:4173,http://localhost:4173',
      dataDirectory: '/checkout/data/.isagi',
      webRoot: '/checkout/apps/web/dist',
    }),
    [
      'serve',
      '--allowed-origins',
      'http://127.0.0.1:4173,http://localhost:4173',
      '--data-dir',
      '/checkout/data/.isagi',
      '--web-root',
      '/checkout/apps/web/dist',
    ],
  );
});

/**
 * `runtime.ts` cannot be imported here — it requires Electron's `app` — so the
 * boundary is verified structurally. An externally attached runtime is not
 * spawned by the desktop at all, which is what makes "an external runtime
 * inherits nothing from the desktop" a property of the wiring rather than of a
 * check.
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
  assert.doesNotMatch(externalTarget, /env|prepare/u);
});
