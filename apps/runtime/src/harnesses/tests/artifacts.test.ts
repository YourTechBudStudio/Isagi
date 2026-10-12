import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Layer, Result } from 'effect';

import { makeLogCapture } from '../../../test/test-support.js';
import { describeOperationalCause } from '../../platform/diagnostics/index.js';
import { DataDirectory } from '../../platform/persistence/index.js';
import { makeTestDataDirectory } from '../../platform/persistence/testing.js';
import { AgentSessionArtifacts } from '../ledger.js';

test('agent session artifacts initialize and read harness metadata', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-agent-artifacts-'));
  try {
    const metadata = await Effect.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* AgentSessionArtifacts;
        yield* artifacts.initializeMetadata(10);
        return yield* artifacts.readMetadata(10);
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(metadata.status, 'valid');
    if (metadata.status === 'valid') {
      assert.equal(metadata.metadata.schemaVersion, 1);
      assert.equal(metadata.metadata.harnessSessionId, null);
      assert.equal(typeof metadata.metadata.updatedAt, 'string');
    }
    assert.equal(
      existsSync(join(dataRoot, 'sessions', 'agent-sessions', '10', 'harness.json')),
      true,
    );
    assert.equal(
      existsSync(join(dataRoot, 'sessions', 'agent-sessions', '10', harnessLogFileName())),
      false,
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('agent session artifacts expose the harness artifact directory without creating JSONL files', async () => {
  // Canonical, like the project root beside it: the runtime resolves its data root, so a fixture
  // that hand-builds an expected path from an unresolved one is doing different arithmetic from the
  // code under test. Canonicalizing here keeps that difference out of tests whose subject is the
  // path *derivation* rather than its resolution.
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-agent-artifact-paths-')));
  try {
    const paths = await Effect.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* AgentSessionArtifacts;
        return artifacts.paths({ agentSessionId: 10 });
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(paths.directory, join(dataRoot, 'sessions', 'agent-sessions', '10'));
    assert.equal(paths.metadataPath, join(paths.directory, 'harness.json'));
    assert.equal(existsSync(join(paths.directory, harnessLogFileName())), false);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('agent session artifacts distinguish missing and invalid metadata', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-agent-artifact-invalid-'));
  try {
    const [missingRead, invalidRead] = await Effect.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* AgentSessionArtifacts;
        const missingResult = yield* artifacts.readMetadata(10);
        yield* artifacts.initializeMetadata(11);
        writeFileSync(
          join(dataRoot, 'sessions', 'agent-sessions', '11', 'harness.json'),
          '{ nope',
          'utf8',
        );
        const invalidResult = yield* artifacts.readMetadata(11);
        return [missingResult, invalidResult] as const;
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(missingRead.status, 'missing');
    assert.equal(invalidRead.status, 'invalid');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('agent session artifacts write observed harness session ids', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-agent-artifact-write-'));
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* AgentSessionArtifacts;
        yield* artifacts.initializeMetadata(10);
        yield* artifacts.writeHarnessSessionId({
          agentSessionId: 10,
          harnessSessionId: 'pi-session-1',
        });
        const raw = JSON.parse(
          readFileSync(join(dataRoot, 'sessions', 'agent-sessions', '10', 'harness.json'), 'utf8'),
        ) as { readonly harnessSessionId?: unknown };
        assert.equal(raw.harnessSessionId, 'pi-session-1');
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('agent session artifacts harden only their own directories and files on Unix', async (context) => {
  if (process.platform === 'win32') {
    context.skip('Unix permission modes are not portable to Windows.');
    return;
  }
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-agent-artifact-permissions-'));
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* AgentSessionArtifacts;
        yield* artifacts.initializeMetadata(10);
        yield* artifacts.prepareProcessArtifacts({ agentSessionId: 10, ptyProcessId: 20 });
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );
    const directory = join(dataRoot, 'sessions', 'agent-sessions', '10');
    const metadata = join(directory, 'harness.json');
    assert.equal(statSync(join(dataRoot, 'sessions', 'agent-sessions')).mode & 0o777, 0o700);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(metadata).mode & 0o777, 0o600);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('agent session artifacts reject a symlinked Isagi harness directory', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-agent-artifact-symlink-'));
  const external = mkdtempSync(join(tmpdir(), 'isagi-agent-artifact-external-'));
  try {
    const root = join(dataRoot, 'sessions', 'agent-sessions');
    mkdirSync(join(dataRoot, 'sessions'), { recursive: true });
    symlinkSync(external, root);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* AgentSessionArtifacts;
        return yield* artifacts
          .prepareProcessArtifacts({ agentSessionId: 10, ptyProcessId: 20 })
          .pipe(Effect.result);
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );
    assert.equal(Result.isFailure(result), true);
    assert.equal(existsSync(join(external, '10')), false);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

// Logs and diagnostics never carry an error's own text, so each failure names the policy that
// refused the path (and the operation it refused) through its safe diagnostic label instead.
test('a refused artifact root is named in the failure and in the construction warning', async () => {
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-agent-artifact-refused-')));
  const external = mkdtempSync(join(tmpdir(), 'isagi-agent-artifact-refused-external-'));
  try {
    mkdirSync(join(dataRoot, 'sessions'), { recursive: true });
    symlinkSync(external, join(dataRoot, 'sessions', 'agent-sessions'));
    const logs = makeLogCapture();
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* AgentSessionArtifacts;
        return yield* Effect.flip(
          artifacts.prepareProcessArtifacts({ agentSessionId: 10, ptyProcessId: 20 }),
        );
      }).pipe(Effect.provide(testLayer(dataRoot)), Effect.provide(logs.layer)),
    );

    assert.equal(failure.code, 'jsonl_init_failed');
    assert.equal(
      describeOperationalCause(failure),
      'Harness artifact operation failed (jsonl_init_failed): Harness artifact path rejected (not_real_directory)',
    );
    assert.deepEqual(
      logs.lines.map((line) => [line.level, line.message, line.annotations.cause]),
      [
        [
          'Warn',
          'Harness artifact root could not be secured; observation will degrade.',
          'Harness artifact path rejected (not_real_directory)',
        ],
      ],
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test('an unavailable artifact inventory logs why it is unavailable', async () => {
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-agent-artifact-inventory-')));
  try {
    mkdirSync(join(dataRoot, 'sessions'), { recursive: true });
    writeFileSync(join(dataRoot, 'sessions', 'agent-sessions'), 'not a directory');
    const logs = makeLogCapture();
    const ids = await Effect.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* AgentSessionArtifacts;
        return yield* artifacts.listAgentSessionIds;
      }).pipe(Effect.provide(testLayer(dataRoot)), Effect.provide(logs.layer)),
    );

    assert.deepEqual(ids, []);
    assert.deepEqual(
      logs.lines.map((line) => [line.level, line.message, line.annotations.cause]),
      [
        [
          'Warn',
          'Harness artifact root could not be secured; observation will degrade.',
          'System error EEXIST',
        ],
        [
          'Warn',
          'Harness artifact inventory is unavailable',
          'Harness artifact path rejected (not_regular_directory)',
        ],
      ],
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('a refused metadata write names the operation and the refused path kind', async () => {
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-agent-artifact-write-refused-')));
  const external = mkdtempSync(join(tmpdir(), 'isagi-agent-artifact-write-refused-external-'));
  try {
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* AgentSessionArtifacts;
        yield* artifacts.initializeMetadata(10);
        const metadataPath = join(dataRoot, 'sessions', 'agent-sessions', '10', 'harness.json');
        rmSync(metadataPath);
        symlinkSync(join(external, 'harness.json'), metadataPath);
        return yield* Effect.flip(
          artifacts.writeHarnessSessionId({ agentSessionId: 10, harnessSessionId: 'pi-session-1' }),
        );
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(failure.code, 'metadata_write_failed');
    assert.equal(
      describeOperationalCause(failure),
      'Harness artifact operation failed (metadata_write_failed): Harness artifact path rejected (not_regular_file)',
    );
    assert.equal(existsSync(join(external, 'harness.json')), false);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test('a refused metadata read keeps its persisted status reason', async () => {
  // The read's diagnostic is persisted as the session's status reason, so its wording is preserved.
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-agent-artifact-read-refused-')));
  try {
    const read = await Effect.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* AgentSessionArtifacts;
        yield* artifacts.initializeMetadata(10);
        const metadataPath = join(dataRoot, 'sessions', 'agent-sessions', '10', 'harness.json');
        rmSync(metadataPath);
        mkdirSync(metadataPath);
        return yield* artifacts.readMetadata(10);
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(read, {
      status: 'invalid',
      metadataPath: join(dataRoot, 'sessions', 'agent-sessions', '10', 'harness.json'),
      diagnostic: 'Invalid harness metadata: Harness artifact path is not a regular file.',
    });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

const graceMs = 60 * 60_000;
const nowMs = Date.parse('2026-10-08T12:00:00.000Z');
const oldDate = new Date(nowMs - 2 * graceMs);

test('agent session folder collection deletes only old folders no row references', async () => {
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-agent-folder-gc-')));
  try {
    const root = join(dataRoot, 'sessions', 'agent-sessions');
    const stats = await Effect.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* AgentSessionArtifacts;
        for (const id of [10, 11, 12, 13]) yield* artifacts.initializeMetadata(id);
        backdateFolder(join(root, '10'));
        backdateFolder(join(root, '11'));
        // 12 stays young. 13 is old, but its harness is still appending to a ledger file.
        backdateFolder(join(root, '13'));
        writeFileSync(join(root, '13', harnessLogFileName()), '{}\n');
        utimesSync(join(root, '13', harnessLogFileName()), new Date(nowMs), new Date(nowMs));
        return yield* artifacts.collectOrphanFolders({
          liveIds: new Set([11]),
          minAgeMs: graceMs,
          nowMs,
        });
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(existsSync(join(root, '10')), false);
    assert.equal(existsSync(join(root, '11')), true);
    assert.equal(existsSync(join(root, '12')), true);
    assert.equal(existsSync(join(root, '13')), true);
    assert.deepEqual(stats.deleted, ['10']);
    assert.equal(stats.kept, 1);
    assert.deepEqual(stats.skippedYoung, ['12', '13']);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('agent session folder collection never reaches outside its root', async () => {
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-agent-folder-gc-decoy-')));
  const worktree = plantDecoyWorktree();
  try {
    const root = join(dataRoot, 'sessions', 'agent-sessions');
    mkdirSync(root, { recursive: true });
    symlinkSync(worktree, join(root, '20'));
    mkdirSync(join(root, 'notes'));
    backdateFolder(join(root, 'notes'));
    writeFileSync(join(root, '21'), 'not a folder');
    utimesSync(join(root, '21'), oldDate, oldDate);

    const stats = await collectWithNoLiveIds(dataRoot);

    assert.equal(stats.inspected, 0);
    assert.equal(existsSync(join(worktree, 'src', 'index.ts')), true);
    assert.equal(existsSync(join(root, 'notes')), true);
    assert.equal(existsSync(join(root, '21')), true);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

for (const linked of ['agent-sessions', 'sessions'] as const) {
  test(`agent session folder collection skips a symlinked ${linked} directory`, async () => {
    const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-agent-folder-gc-link-')));
    const worktree = plantDecoyWorktree();
    try {
      mkdirSync(join(worktree, '30'));
      backdateFolder(join(worktree, '30'));
      if (linked === 'sessions') {
        symlinkSync(worktree, join(dataRoot, 'sessions'));
      } else {
        mkdirSync(join(dataRoot, 'sessions'));
        symlinkSync(worktree, join(dataRoot, 'sessions', 'agent-sessions'));
      }

      const stats = await collectWithNoLiveIds(dataRoot);

      assert.equal(stats.inspected, 0);
      assert.equal(existsSync(join(worktree, '30')), true);
      assert.equal(existsSync(join(worktree, 'src', 'index.ts')), true);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });
}

test('agent session folder collection skips an unreadable root and collects once it is restored', async (context) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    context.skip('chmod 000 does not block reads on Windows or as root.');
    return;
  }
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-agent-folder-gc-unreadable-')));
  const root = join(dataRoot, 'sessions', 'agent-sessions');
  try {
    mkdirSync(join(root, '40'), { recursive: true });
    backdateFolder(join(root, '40'));
    // One layer for both ticks: building the artifacts layer re-secures the root's mode.
    const [blocked, restored] = await Effect.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* AgentSessionArtifacts;
        const collect = artifacts.collectOrphanFolders({
          liveIds: new Set(),
          minAgeMs: graceMs,
          nowMs,
        });
        chmodSync(root, 0o000);
        const first = yield* collect;
        chmodSync(root, 0o700);
        assert.equal(existsSync(join(root, '40')), true);
        return [first, yield* collect] as const;
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );
    assert.equal(blocked.inspected, 0);
    assert.deepEqual(restored.deleted, ['40']);
  } finally {
    chmodSync(root, 0o700);
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('agent session folder collection skips a root replaced by a file and collects once it is restored', async () => {
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-agent-folder-gc-file-')));
  const root = join(dataRoot, 'sessions', 'agent-sessions');
  try {
    await collectWithNoLiveIds(dataRoot);
    rmSync(root, { recursive: true, force: true });
    writeFileSync(root, 'not a directory');
    const blocked = await collectWithNoLiveIds(dataRoot);
    assert.equal(blocked.inspected, 0);

    rmSync(root);
    mkdirSync(join(root, '41'), { recursive: true });
    backdateFolder(join(root, '41'));
    const restored = await collectWithNoLiveIds(dataRoot);
    assert.deepEqual(restored.deleted, ['41']);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

function collectWithNoLiveIds(dataRoot: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const artifacts = yield* AgentSessionArtifacts;
      return yield* artifacts.collectOrphanFolders({
        liveIds: new Set(),
        minAgeMs: graceMs,
        nowMs,
      });
    }).pipe(Effect.provide(testLayer(dataRoot))),
  );
}

/** A folder outside the data root standing in for a user's worktree; every file must survive. */
function plantDecoyWorktree() {
  const worktree = mkdtempSync(join(tmpdir(), 'isagi-agent-folder-gc-worktree-'));
  mkdirSync(join(worktree, 'src'));
  writeFileSync(join(worktree, 'src', 'index.ts'), 'export {};\n');
  utimesSync(join(worktree, 'src', 'index.ts'), oldDate, oldDate);
  utimesSync(join(worktree, 'src'), oldDate, oldDate);
  utimesSync(worktree, oldDate, oldDate);
  return worktree;
}

function backdateFolder(path: string) {
  for (const name of readdirSync(path)) utimesSync(join(path, name), oldDate, oldDate);
  utimesSync(path, oldDate, oldDate);
}

function testLayer(dataRoot: string) {
  return AgentSessionArtifacts.layer.pipe(
    Layer.provide(Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot))),
  );
}

function harnessLogFileName(harnessSessionId = 'pi-session-1') {
  return `${Buffer.from(harnessSessionId, 'utf8').toString('hex')}.harness.jsonl`;
}
