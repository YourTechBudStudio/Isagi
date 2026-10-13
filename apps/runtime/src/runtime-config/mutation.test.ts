import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Result } from 'effect';

import { DataDirectory, type IsagiDataDirectory } from '../platform/persistence/index.js';
import { makeTestDataDirectory } from '../platform/persistence/testing.js';
import { disabledHarnessPolicy } from './policy.js';
import { RuntimeConfig, RuntimeConfigConflict, RuntimeConfigError } from './service.js';
function paths(root: string): IsagiDataDirectory {
  return makeTestDataDirectory(root).paths;
}
function program(root: string) {
  return Effect.gen(function* () {
    return yield* RuntimeConfig;
  }).pipe(
    Effect.provide(RuntimeConfig.layer),
    Effect.provideService(DataDirectory, { paths: paths(root) }),
  );
}
test('policy mutation preserves comments and unrelated fields while updating live policy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-config-mutation-'));
  try {
    writeFileSync(
      join(root, 'config.yaml'),
      `# keep this\nother: value\npty:\n  backend: node-pty\nterminal:\n  scrollbackLines: 12000\n  cache:\n    idleTtlMinutes: 45\n    maxHiddenSessions: 8\n    maxEstimatedBufferMiB: 256\nworkflows:\n  additionalDirectories:\n    - ${join(root, 'extra workflows')}\n`,
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
          assert.deepEqual(accepted.workflows.additionalDirectories, [
            join(root, 'extra workflows'),
          ]);
          assert.deepEqual(accepted.terminal, {
            scrollbackLines: 12_000,
            cache: {
              idleTtlMinutes: 45,
              maxHiddenSessions: 8,
              maxEstimatedBufferMiB: 256,
            },
          });
        }),
      ),
    );
    const bytes = readFileSync(join(root, 'config.yaml'), 'utf8');
    assert.match(bytes, /# keep this/);
    assert.match(bytes, /other: value/);
    assert.match(bytes, /additionalDirectories/);
    assert.match(
      bytes,
      /terminal:\n  scrollbackLines: 12000\n  cache:\n    idleTtlMinutes: 45\n    maxHiddenSessions: 8\n    maxEstimatedBufferMiB: 256\n/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('policy mutation rejects malformed workflow config without writing or changing live state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-config-invalid-workflows-'));
  const path = join(root, 'config.yaml');
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* program(root);
          const before = yield* service.get;
          const malformed = 'workflows:\n  additionalDirectories:\n    - relative/path\n';
          yield* Effect.sync(() => writeFileSync(path, malformed, 'utf8'));
          const result = yield* service
            .acceptHarnessPolicy({
              expectedPolicyRevision: before.harnesses.revision,
              policy: disabledHarnessPolicy,
            })
            .pipe(Effect.result);
          assert.ok(Result.isFailure(result));
          assert.ok(result.failure instanceof RuntimeConfigError);
          assert.deepEqual(yield* service.get, before);
          assert.equal(readFileSync(path, 'utf8'), malformed);
        }),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('policy mutation maps a malformed source-race reread to RuntimeConfigError', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-config-race-invalid-workflows-'));
  const path = join(root, 'config.yaml');
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* program(root);
          const before = yield* service.get;
          const malformed = 'workflows:\n  additionalDirectories:\n    - relative/path\n';
          let changed = false;
          const racingPolicy = new Proxy(disabledHarnessPolicy, {
            ownKeys(target) {
              if (!changed) {
                changed = true;
                writeFileSync(path, malformed, 'utf8');
              }
              return Reflect.ownKeys(target);
            },
          });

          const result = yield* service
            .acceptHarnessPolicy({
              expectedPolicyRevision: before.harnesses.revision,
              policy: racingPolicy,
            })
            .pipe(Effect.result);

          assert.ok(Result.isFailure(result));
          assert.ok(result.failure instanceof RuntimeConfigError);
          assert.deepEqual(yield* service.get, before);
          assert.equal(readFileSync(path, 'utf8'), malformed);
        }),
      ),
    );
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
            .pipe(Effect.result);
          assert.equal(Result.isFailure(result), true);
          if (Result.isFailure(result))
            assert.equal(result.failure instanceof RuntimeConfigConflict, true);
        }),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('policy mutation succeeds and preserves an invalid fluidcast section', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-config-invalid-fluidcast-'));
  const path = join(root, 'config.yaml');
  try {
    writeFileSync(path, 'fluidcast:\n  enabled: true\n  speech: 42\n', 'utf8');
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* program(root);
          const before = yield* service.get;
          assert.equal(before.fluidcast.status, 'invalid');
          const next = {
            ...disabledHarnessPolicy,
            claude: { enabled: true, installIsagiDocs: false },
          };
          const accepted = yield* service.acceptHarnessPolicy({
            expectedPolicyRevision: before.harnesses.revision,
            policy: next,
          });
          assert.deepEqual(accepted.harnesses.policy.claude, next.claude);
          assert.equal(accepted.fluidcast.status, 'invalid');
        }),
      ),
    );
    assert.match(readFileSync(path, 'utf8'), /fluidcast:\n  enabled: true\n  speech: 42\n/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
