import assert from 'node:assert/strict';
import test from 'node:test';

import { Cause, Effect, Exit, Layer } from 'effect';

import { makeLogCapture } from '../../test/test-support.js';
import { RuntimeConfig } from '../runtime-config/index.js';
import { defaultRuntimeConfig } from '../runtime-config/testing.js';
import { NodePtyBackend } from './adapters/node-pty.js';
import { PtyBackendCatalog } from './backend.js';
import type { PtyBackendShape } from './index.js';

test('PTY backend catalog selects configured node-pty for launches and logs it', async () => {
  const logs = makeLogCapture();
  const catalog = await Effect.runPromise(builtCatalog().pipe(Effect.provide(logs.layer)));

  assert.equal(catalog.configured.name, 'node_pty');
  assert.ok(logs.lines.some((line) => line.message === 'PTY launch backend selected'));
  assert.equal(logs.lines.filter((line) => line.level === 'Warn').length, 0);
});

test('PTY backend catalog resolves a persisted node-pty row to its adapter', async () => {
  const catalog = await Effect.runPromise(builtCatalog());

  assert.equal(Effect.runSync(catalog.forBackend('node_pty')).name, 'node_pty');
  assert.equal(catalog.isRetired('node_pty'), false);
});

test('PTY backend catalog knows a retired persisted backend and refuses to resolve it', async () => {
  const catalog = await Effect.runPromise(builtCatalog());

  // A historical row may still say `tmux`. It is known vocabulary, not
  // corruption, but no adapter can operate it.
  assert.equal(catalog.isRetired('tmux'), true);
  assert.match(defectOf(catalog, 'tmux'), /Persisted PTY backend tmux is retired/);
});

test('PTY backend catalog fails loudly on an out-of-model persisted backend', async () => {
  const catalog = await Effect.runPromise(builtCatalog());

  // `backend` is bare text in SQLite with no CHECK constraint, so corruption is
  // reachable. It must not resolve to the configured adapter: it is a defect.
  assert.match(defectOf(catalog, 'screen'), /Unknown persisted PTY backend screen/);
  assert.equal(catalog.isRetired('screen' as never), false);
  // And an inherited key must not resolve to something that is not an adapter at
  // all — the reason resolution is own-property guarded rather than a bare index.
  assert.match(defectOf(catalog, 'toString'), /Unknown persisted PTY backend toString/);
  assert.equal(catalog.isRetired('toString' as never), false);
});

test('PTY backend catalog exposes only registered adapters for backend-only sweeps', async () => {
  const catalog = await Effect.runPromise(builtCatalog());

  assert.deepEqual(
    catalog.all.map((backend) => backend.name),
    ['node_pty'],
  );
});

function defectOf(catalog: PtyBackendCatalog['Service'], name: string) {
  const exit = Effect.runSyncExit(catalog.forBackend(name as never));
  assert.ok(Exit.isFailure(exit) && Cause.hasDies(exit.cause));
  return String(Cause.squash(exit.cause));
}

function builtCatalog() {
  const service = {
    get: Effect.succeed(defaultRuntimeConfig),
    acceptHarnessPolicy: () => Effect.die('acceptHarnessPolicy is not used'),
  } satisfies RuntimeConfig['Service'];
  return Effect.gen(function* () {
    return yield* PtyBackendCatalog;
  }).pipe(
    Effect.provide(PtyBackendCatalog.layerNoDeps),
    Effect.provideService(RuntimeConfig, service),
    Effect.provide(Layer.succeed(NodePtyBackend, fakeBackend())),
  );
}

function fakeBackend(): PtyBackendShape {
  return {
    name: 'node_pty',
    available: Effect.succeed(true),
    launch: () => Effect.die('launch is not used by backend catalog tests'),
    writeInput: () => Effect.die('writeInput is not used by backend catalog tests'),
    attach: () => Effect.die('attach is not used by backend catalog tests'),
    replay: () => Effect.die('replay is not used by backend catalog tests'),
    inspect: () => Effect.die('inspect is not used by backend catalog tests'),
    listSessions: Effect.die('listSessions is not used by backend catalog tests'),
    kill: () => Effect.die('kill is not used by backend catalog tests'),
  };
}
