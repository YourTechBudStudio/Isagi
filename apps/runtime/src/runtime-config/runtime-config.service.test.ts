import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { Effect, Either } from 'effect';

import { DataDirectory, type IsagiDataDirectory } from '../persistence/index.js';
import { RuntimeConfig, RuntimeConfigError, RuntimeConfigLive } from './runtime-config.service.js';

test('runtime config creates config.yaml with node-pty as the default PTY backend', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-runtime-config-'));
  try {
    const config = await Effect.runPromise(readConfig(root));

    assert.deepEqual(config, { pty: { backend: 'node-pty' } });
    assert.equal(readFileSync(join(root, 'config.yaml'), 'utf8'), 'pty:\n  backend: node-pty\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runtime config reads a configured tmux PTY backend', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-runtime-config-'));
  try {
    writeFileSync(join(root, 'config.yaml'), 'pty:\n  backend: tmux\n', 'utf8');

    const config = await Effect.runPromise(readConfig(root));

    assert.deepEqual(config, { pty: { backend: 'tmux' } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runtime config defaults a missing PTY backend without rewriting the file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-runtime-config-'));
  try {
    writeFileSync(join(root, 'config.yaml'), 'other: value\npty:\n  note: keep-me\n', 'utf8');

    const config = await Effect.runPromise(readConfig(root));

    assert.deepEqual(config, { pty: { backend: 'node-pty' } });
    assert.equal(
      readFileSync(join(root, 'config.yaml'), 'utf8'),
      'other: value\npty:\n  note: keep-me\n',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runtime config defaults a null PTY backend', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-runtime-config-'));
  try {
    writeFileSync(join(root, 'config.yaml'), 'pty:\n  backend:\n', 'utf8');

    const config = await Effect.runPromise(readConfig(root));

    assert.deepEqual(config, { pty: { backend: 'node-pty' } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runtime config rejects unsupported PTY backends', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-runtime-config-'));
  try {
    writeFileSync(join(root, 'config.yaml'), 'pty:\n  backend: imaginary\n', 'utf8');

    const result = await Effect.runPromise(readConfig(root).pipe(Effect.either));

    assert.equal(Either.isLeft(result), true);
    if (Either.isLeft(result)) {
      assert.equal(result.left instanceof RuntimeConfigError, true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function readConfig(root: string) {
  return Effect.gen(function* () {
    const config = yield* RuntimeConfig;
    const current = yield* config.get;
    return { pty: current.pty };
  }).pipe(
    Effect.provide(RuntimeConfigLive),
    Effect.provideService(DataDirectory, { paths: paths(root) }),
  );
}

function paths(root: string): IsagiDataDirectory {
  return {
    root,
    databasePath: resolve(root, 'isagi.db'),
    statePath: resolve(root, 'state.json'),
    worktreesPath: resolve(root, 'worktrees'),
    sessionsPath: resolve(root, 'sessions'),
    workflowsPath: resolve(root, 'workflows'),
  };
}
