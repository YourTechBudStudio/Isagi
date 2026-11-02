import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Redacted } from 'effect';

import type { RuntimeLaunch } from '@isagi/cli/serve-launch';

import { LauncherToken } from '../access/index.js';
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
    launcherToken: 'launcher-token',
  };

  const inputs = await Effect.runPromise(
    Effect.all({
      server: ServerLaunch,
      root: DataDirectoryRoot,
      entry: CliEntry,
      launcher: LauncherToken,
      // A structured clone: the launch arrives from the CLI's bundle, so only plain data may cross. A value that
      // needs the CLI's own `effect` to read (a `Redacted`) would not survive this, as it did not in the packaged app.
    }).pipe(Effect.provide(launchInputsLayer(structuredClone(launch)))),
  );

  assert.deepEqual(inputs.server, {
    host: launch.host,
    port: undefined,
    webRoot: launch.webRoot,
    allowedOrigins: ['https://isagi.example.test'],
  });
  assert.deepEqual(inputs.root, { path: '/srv/isagi' });
  assert.deepEqual(inputs.entry, { path: '/opt/isagi/isagi.mjs' });
  assert.ok(inputs.launcher.token !== undefined && Redacted.isRedacted(inputs.launcher.token));
  assert.equal(Redacted.value(inputs.launcher.token), 'launcher-token');
  assert.ok(!('launcherToken' in inputs.server));
});
