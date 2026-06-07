import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { DataDirectory, type IsagiDataDirectory } from './data-directory.js';
import { StateFile, StateFileLive, stateFromActiveContext } from './state-file.js';

test('malformed state file recovery is logged and stays out of the returned state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-state-'));
  const paths = {
    root,
    databasePath: resolve(root, 'isagi.db'),
    statePath: resolve(root, 'state.json'),
    worktreesPath: resolve(root, 'worktrees'),
  } satisfies IsagiDataDirectory;
  writeFileSync(paths.statePath, '{ not json', 'utf8');

  const warnings: unknown[] = [];
  const originalConsoleWarn = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(message);
  };

  try {
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const stateFile = yield* StateFile;
        return yield* stateFile.read;
      }).pipe(Effect.provide(StateFileLive), Effect.provideService(DataDirectory, { paths })),
    );

    assert.deepEqual(state, {
      version: 1,
      workspace: { activeProjectId: null, activeWorktreeId: null, activeContextRevision: 0 },
    });
    assert.equal('recoveryNotice' in state, false);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]), /^Recovered malformed Isagi state file/);
    assert.equal(existsSync(paths.statePath), true);
    assert.deepEqual(JSON.parse(readFileSync(paths.statePath, 'utf8')), state);
    assert.ok(readdirSync(root).some((entry) => entry.startsWith('state.json.malformed-')));
  } finally {
    console.warn = originalConsoleWarn;
    rmSync(root, { recursive: true, force: true });
  }
});

test('active context writes keep the highest revision durable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-state-'));
  const paths = {
    root,
    databasePath: resolve(root, 'isagi.db'),
    statePath: resolve(root, 'state.json'),
    worktreesPath: resolve(root, 'worktrees'),
  } satisfies IsagiDataDirectory;

  try {
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const stateFile = yield* StateFile;
        yield* stateFile.write(stateFromActiveContext(2, 20, 2));
        yield* stateFile.writeActiveContextIfFresh({
          activeProjectId: 3,
          activeWorktreeId: 30,
          revision: 2,
        });
        return yield* stateFile.writeActiveContextIfFresh({
          activeProjectId: 1,
          activeWorktreeId: 10,
          revision: 1,
        });
      }).pipe(Effect.provide(StateFileLive), Effect.provideService(DataDirectory, { paths })),
    );

    assert.deepEqual(state, stateFromActiveContext(2, 20, 2));
    assert.deepEqual(JSON.parse(readFileSync(paths.statePath, 'utf8')), state);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
