import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Either, Layer } from 'effect';

import { DataDirectory } from '../../persistence/index.js';
import { makeTestDataDirectory } from '../../persistence/test-support.js';
import { AgentSessionArtifacts, AgentSessionArtifactsLive } from '../harness/ledger.js';

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
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-agent-artifact-paths-'));
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

test('agent session artifacts write observed harness session ids and remove directories', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-agent-artifact-write-'));
  try {
    const existsAfterRemove = await Effect.runPromise(
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
        yield* artifacts.removeDirectory(10);
        return existsSync(join(dataRoot, 'sessions', 'agent-sessions', '10'));
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(existsAfterRemove, false);
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
          .pipe(Effect.either);
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );
    assert.equal(Either.isLeft(result), true);
    assert.equal(existsSync(join(external, '10')), false);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

function testLayer(dataRoot: string) {
  return AgentSessionArtifactsLive.pipe(
    Layer.provide(Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot))),
  );
}

function harnessLogFileName(harnessSessionId = 'pi-session-1') {
  return `${Buffer.from(harnessSessionId, 'utf8').toString('hex')}.harness.jsonl`;
}
