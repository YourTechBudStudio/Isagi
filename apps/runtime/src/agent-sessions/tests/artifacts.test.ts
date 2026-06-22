import assert from 'node:assert/strict';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Layer } from 'effect';

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

test('agent session artifacts discover hook-owned JSONL files and tolerate bad lines', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-agent-artifact-jsonl-'));
  try {
    const reads = await Effect.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* AgentSessionArtifacts;
        const paths = yield* artifacts.prepareProcessArtifacts({
          agentSessionId: 10,
          ptyProcessId: 20,
        });
        const jsonlPath = join(paths.directory, harnessLogFileName());
        assert.equal(existsSync(jsonlPath), false);
        appendFileSync(jsonlPath, '{ nope\n', 'utf8');
        appendFileSync(
          jsonlPath,
          `${JSON.stringify({
            schemaVersion: 1,
            recordedAt: '2026-06-18T00:00:00.000Z',
            agentSessionId: 10,
            harnessSessionId: 'pi-session-1',
            ptyProcessId: 20,
            harness: 'pi',
            nativeEvent: 'agent_start',
            event: { nativeEvent: 'agent_start' },
          })}\n`,
          'utf8',
        );
        return yield* artifacts.readJsonlForAgentSession(10);
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    const read = reads[0];
    assert.ok(read);
    assert.equal(read.ignoredLineCount, 1);
    assert.equal(read.records.length, 1);
    assert.equal(read.records[0]?.nativeEvent, 'agent_start');
    assert.equal(read.records[0]?.harnessSessionId, 'pi-session-1');
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

function testLayer(dataRoot: string) {
  return AgentSessionArtifactsLive.pipe(
    Layer.provide(Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot))),
  );
}

function harnessLogFileName(harnessSessionId = 'pi-session-1') {
  return `${Buffer.from(harnessSessionId, 'utf8').toString('hex')}.harness.jsonl`;
}
