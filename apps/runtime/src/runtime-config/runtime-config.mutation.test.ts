import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { Effect, Either } from 'effect';

import { DataDirectory, type IsagiDataDirectory } from '../persistence/index.js';
import { disabledHarnessPolicy } from './runtime-config.policy.js';
import {
  RuntimeConfig,
  RuntimeConfigConflict,
  RuntimeConfigLive,
} from './runtime-config.service.js';
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
function program(root: string) {
  return Effect.gen(function* () {
    return yield* RuntimeConfig;
  }).pipe(
    Effect.provide(RuntimeConfigLive),
    Effect.provideService(DataDirectory, { paths: paths(root) }),
  );
}
test('policy mutation preserves comments and unrelated fields while updating live policy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-config-mutation-'));
  try {
    writeFileSync(
      join(root, 'config.yaml'),
      '# keep this\nother: value\npty:\n  backend: node-pty\n',
      'utf8',
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* program(root);
          const before = yield* service.get;
          const next = {
            ...disabledHarnessPolicy,
            codex: { enabled: true, installIsagiDocs: true },
          };
          const accepted = yield* service.acceptHarnessPolicy({
            expectedPolicyRevision: before.harnesses.revision,
            policy: next,
          });
          assert.deepEqual(accepted.harnesses.policy.codex, next.codex);
          assert.deepEqual((yield* service.get).harnesses.policy.codex, next.codex);
        }),
      ),
    );
    const bytes = readFileSync(join(root, 'config.yaml'), 'utf8');
    assert.match(bytes, /# keep this/);
    assert.match(bytes, /other: value/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('policy mutation rejects a stale semantic revision without rewriting', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-config-conflict-'));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* program(root);
          const result = yield* service
            .acceptHarnessPolicy({ expectedPolicyRevision: 'stale', policy: disabledHarnessPolicy })
            .pipe(Effect.either);
          assert.equal(Either.isLeft(result), true);
          if (Either.isLeft(result))
            assert.equal(result.left instanceof RuntimeConfigConflict, true);
        }),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
