import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Layer } from 'effect';

import {
  defaultRuntimeConfig,
  RuntimeConfig,
  type RuntimeConfigService,
} from '../runtime-config/index.js';
import { NodePtyBackend } from './adapters/node-pty.js';
import { TmuxBackend } from './adapters/tmux.js';
import { PtyBackendCatalog, PtyBackendCatalogLive } from './backend.js';
import type { PtyBackendShape } from './index.js';

test('PTY backend catalog defaults its launch preference to configured node-pty even when tmux is available', async () => {
  const catalog = await Effect.runPromise(
    builtCatalog({ pty: { backend: 'node-pty' } }, { tmuxAvailable: true }),
  );

  assert.equal(catalog.configured.name, 'node_pty');
});

test('PTY backend catalog selects configured tmux for launches', async () => {
  const catalog = await Effect.runPromise(
    builtCatalog({ pty: { backend: 'tmux' } }, { tmuxAvailable: true }),
  );

  assert.equal(catalog.configured.name, 'tmux');
});

test('PTY backend catalog warns when configured tmux is unavailable', async () => {
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    const catalog = await Effect.runPromise(
      builtCatalog({ pty: { backend: 'tmux' } }, { tmuxAvailable: false }),
    );

    assert.equal(catalog.configured.name, 'tmux');
    assert.match(String(warnings[0]?.[0]), /Configured PTY backend tmux is unavailable/);
  } finally {
    console.warn = originalWarn;
  }
});

test('PTY backend catalog resolves a persisted backend regardless of launch preference', async () => {
  const nodePtyConfigured = await Effect.runPromise(
    builtCatalog({ pty: { backend: 'node-pty' } }, { tmuxAvailable: true }),
  );
  const tmuxConfigured = await Effect.runPromise(
    builtCatalog({ pty: { backend: 'tmux' } }, { tmuxAvailable: true }),
  );

  // The whole point of the catalog: an existing incarnation is operated through
  // the transport that created it, never through the current preference.
  assert.equal(nodePtyConfigured.forBackend('tmux').name, 'tmux');
  assert.equal(nodePtyConfigured.forBackend('node_pty').name, 'node_pty');
  assert.equal(tmuxConfigured.forBackend('node_pty').name, 'node_pty');
  assert.equal(tmuxConfigured.forBackend('tmux').name, 'tmux');
});

test('PTY backend catalog resolves an unavailable adapter rather than substituting the configured one', async () => {
  const catalog = await Effect.runPromise(
    builtCatalog({ pty: { backend: 'node-pty' } }, { tmuxAvailable: false }),
  );

  const tmux = catalog.forBackend('tmux');
  assert.equal(tmux.name, 'tmux');
  // Unavailability is reported by the adapter, not papered over by dispatch:
  // silently returning node-pty here would aim a kill at the wrong process.
  assert.equal(await Effect.runPromise(tmux.available), false);
});

test('PTY backend catalog fails loudly on an out-of-model persisted backend', async () => {
  const catalog = await Effect.runPromise(
    builtCatalog({ pty: { backend: 'node-pty' } }, { tmuxAvailable: true }),
  );

  // `backend` is bare text in SQLite with no CHECK constraint, so corruption is
  // reachable. It must not resolve to the configured adapter.
  assert.throws(
    () => catalog.forBackend('screen' as never),
    /Unknown persisted PTY backend screen/,
  );
  // And an inherited key must not resolve to something that is not an adapter at
  // all — the reason resolution is own-property guarded rather than a bare index.
  assert.throws(
    () => catalog.forBackend('toString' as never),
    /Unknown persisted PTY backend toString/,
  );
});

test('PTY backend catalog exposes every registered adapter for backend-only sweeps', async () => {
  const catalog = await Effect.runPromise(
    builtCatalog({ pty: { backend: 'node-pty' } }, { tmuxAvailable: true }),
  );

  assert.deepEqual(catalog.all.map((backend) => backend.name).sort(), ['node_pty', 'tmux']);
});

function builtCatalog(
  config: { readonly pty: { readonly backend: 'node-pty' | 'tmux' } },
  options: { readonly tmuxAvailable: boolean },
) {
  const value = { ...defaultRuntimeConfig, pty: config.pty };
  const service = {
    get: Effect.succeed(value),
    acceptHarnessPolicy: () => Effect.die('acceptHarnessPolicy is not used'),
  } satisfies RuntimeConfigService;
  return Effect.gen(function* () {
    return yield* PtyBackendCatalog;
  }).pipe(
    Effect.provide(PtyBackendCatalogLive),
    Effect.provideService(RuntimeConfig, service),
    Effect.provide(Layer.succeed(NodePtyBackend, fakeBackend('node_pty', true))),
    Effect.provide(Layer.succeed(TmuxBackend, fakeBackend('tmux', options.tmuxAvailable))),
  );
}

function fakeBackend(name: PtyBackendShape['name'], available: boolean): PtyBackendShape {
  return {
    name,
    available: Effect.succeed(available),
    launch: () => Effect.die('launch is not used by backend catalog tests'),
    writeInput: () => Effect.die('writeInput is not used by backend catalog tests'),
    attach: () => Effect.die('attach is not used by backend catalog tests'),
    replay: () => Effect.die('replay is not used by backend catalog tests'),
    inspect: () => Effect.die('inspect is not used by backend catalog tests'),
    listSessions: Effect.die('listSessions is not used by backend catalog tests'),
    kill: () => Effect.die('kill is not used by backend catalog tests'),
  };
}
