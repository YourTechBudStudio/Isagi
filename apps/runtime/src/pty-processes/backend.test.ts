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
import { PtyBackend, PtyBackendLive } from './backend.js';
import type { PtyBackendShape } from './index.js';

test('PTY backend defaults to configured node-pty even when tmux is available', async () => {
  const backend = await Effect.runPromise(
    selectedBackend({ pty: { backend: 'node-pty' } }, { tmuxAvailable: true }),
  );

  assert.equal(backend.name, 'node_pty');
});

test('PTY backend selects configured tmux', async () => {
  const backend = await Effect.runPromise(
    selectedBackend({ pty: { backend: 'tmux' } }, { tmuxAvailable: true }),
  );

  assert.equal(backend.name, 'tmux');
});

test('PTY backend warns when configured tmux is unavailable', async () => {
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    const backend = await Effect.runPromise(
      selectedBackend({ pty: { backend: 'tmux' } }, { tmuxAvailable: false }),
    );

    assert.equal(backend.name, 'tmux');
    assert.match(String(warnings[0]?.[0]), /Configured PTY backend tmux is unavailable/);
  } finally {
    console.warn = originalWarn;
  }
});

function selectedBackend(
  config: { readonly pty: { readonly backend: 'node-pty' | 'tmux' } },
  options: { readonly tmuxAvailable: boolean },
) {
  const value = { ...defaultRuntimeConfig, pty: config.pty };
  const service = {
    get: Effect.succeed(value),
    acceptHarnessPolicy: () => Effect.die('acceptHarnessPolicy is not used'),
  } satisfies RuntimeConfigService;
  return Effect.gen(function* () {
    return yield* PtyBackend;
  }).pipe(
    Effect.provide(PtyBackendLive),
    Effect.provideService(RuntimeConfig, service),
    Effect.provide(Layer.succeed(NodePtyBackend, fakeBackend('node_pty', true))),
    Effect.provide(Layer.succeed(TmuxBackend, fakeBackend('tmux', options.tmuxAvailable))),
  );
}

function fakeBackend(name: PtyBackendShape['name'], available: boolean): PtyBackendShape {
  return {
    name,
    available: Effect.succeed(available),
    launch: () => Effect.die('launch is not used by backend selection tests'),
    writeInput: () => Effect.die('writeInput is not used by backend selection tests'),
    attach: () => Effect.die('attach is not used by backend selection tests'),
    replay: () => Effect.die('replay is not used by backend selection tests'),
    inspect: () => Effect.die('inspect is not used by backend selection tests'),
    listSessions: Effect.die('listSessions is not used by backend selection tests'),
    kill: () => Effect.die('kill is not used by backend selection tests'),
  };
}
