import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import type { RuntimeLaunch } from '@isagi/cli/serve-launch';

import { CliEntry } from '../cli-access/index.js';
import { DataDirectoryRoot } from '../platform/persistence/index.js';
import { launchInputsLayer, ServerLaunch } from './launch.js';

test('the launch is split into the inputs each owner reads', async () => {
  const launch: RuntimeLaunch = {
    host: { value: '0.0.0.0', source: 'env', name: 'ISAGI_HOST' },
    port: undefined,
    dataDirectory: { value: '/srv/isagi', source: 'flag', name: '--data-dir' },
    webRoot: { value: '/srv/web', source: 'flag', name: '--web-root' },
    allowedOrigins: ['https://isagi.example.test'],
    cliEntryPath: '/opt/isagi/isagi.mjs',
  };

  const inputs = await Effect.runPromise(
    Effect.all({ server: ServerLaunch, root: DataDirectoryRoot, entry: CliEntry }).pipe(
      Effect.provide(launchInputsLayer(launch)),
    ),
  );

  assert.deepEqual(inputs.server, {
    host: launch.host,
    port: undefined,
    webRoot: launch.webRoot,
    allowedOrigins: ['https://isagi.example.test'],
  });
  assert.deepEqual(inputs.root, { path: '/srv/isagi' });
  assert.deepEqual(inputs.entry, { path: '/opt/isagi/isagi.mjs' });
});
