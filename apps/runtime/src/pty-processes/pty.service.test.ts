import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Either, Layer } from 'effect';

import {
  DataDirectory,
  RuntimeDatabaseLive,
  type DataDirectoryService,
} from '../persistence/index.js';
import { InternalRuntimeEventBusLive } from '../runtime-events/index.js';
import { PtyBackend } from './backend.js';
import { PtyForegroundStateLive } from './foreground-state.js';
import { PtyRepository, PtyRepositoryLive } from './pty.repository.js';
import { PtyService, PtyServiceLive } from './pty.service.js';
import { PtyServiceError, type PtyBackend as PtyBackendShape } from './types.js';

function dataDirectoryLayer(dataRoot: string) {
  const dataDirectory = {
    paths: {
      root: dataRoot,
      databasePath: join(dataRoot, 'isagi.db'),
      statePath: join(dataRoot, 'state.json'),
      worktreesPath: join(dataRoot, 'worktrees'),
      sessionsPath: join(dataRoot, 'sessions'),
    },
  } satisfies DataDirectoryService;
  return Layer.succeed(DataDirectory, dataDirectory);
}

function testLayer(dataRoot: string) {
  const directory = dataDirectoryLayer(dataRoot);
  const database = RuntimeDatabaseLive.pipe(Layer.provide(directory));
  const repository = PtyRepositoryLive.pipe(Layer.provide(database));
  return Layer.mergeAll(database, repository);
}

function serviceTestLayer(dataRoot: string, backend: PtyBackendShape) {
  const directory = dataDirectoryLayer(dataRoot);
  const database = RuntimeDatabaseLive.pipe(Layer.provide(directory));
  const repository = PtyRepositoryLive.pipe(Layer.provide(database));
  const backendLayer = Layer.succeed(PtyBackend, backend);
  const service = PtyServiceLive.pipe(
    Layer.provide(repository),
    Layer.provide(backendLayer),
    Layer.provide(PtyForegroundStateLive),
    Layer.provide(directory),
    Layer.provide(InternalRuntimeEventBusLive),
  );
  return Layer.mergeAll(database, repository, service);
}

test('PTY process repository creates owner-unaware process metadata', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-process-repository-'));
  try {
    const row = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* PtyRepository;
        const id = yield* repository.createProcessMetadata({
          command: 'bash',
          args: ['-l'],
          cwd: '/repo/isagi',
        });
        return yield* repository.findProcess(id);
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.ok(row);
    assert.equal(row.command, 'bash');
    assert.deepEqual(row.args, ['-l']);
    assert.equal(row.cwd, '/repo/isagi');
    assert.equal(row.status, 'starting');
    assert.equal(row.logMode, 'none');
    assert.equal(row.logPath, null);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('PTY process repository transitions process lifecycle facts only', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-process-transition-'));
  try {
    const row = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* PtyRepository;
        const id = yield* repository.createProcessMetadata({
          command: 'bash',
          args: [],
          cwd: '/repo/isagi',
        });
        yield* repository.transitionProcess({
          ptyProcessId: id,
          status: 'failed',
          statusReason: 'backend_launch_failed',
          exitCode: 1,
          signal: null,
        });
        return yield* repository.findProcess(id);
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.ok(row);
    assert.equal(row.status, 'failed');
    assert.equal(row.statusReason, 'backend_launch_failed');
    assert.equal(row.exitCode, 1);
    assert.equal(row.exitedAt !== null, true);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('PTY process service rejects concurrent websocket attachments for the same process', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-process-attach-claim-'));
  let attachCalls = 0;
  try {
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const pty = yield* PtyService;
        const process = yield* pty.launch({ command: 'bash', args: [], cwd: '/repo/isagi' });
        return yield* Effect.all(
          [
            pty.attach({ ptyProcessId: process.ptyProcessId, send: () => {} }).pipe(Effect.either),
            pty.attach({ ptyProcessId: process.ptyProcessId, send: () => {} }).pipe(Effect.either),
          ],
          { concurrency: 'unbounded' },
        );
      }).pipe(
        Effect.provide(
          serviceTestLayer(
            dataRoot,
            delayedAttachBackend(() => attachCalls++),
          ),
        ),
      ),
    );

    assert.equal(attachCalls, 1);
    const failures = results.filter(Either.isLeft).map((result) => result.left);
    const successes = results.filter(Either.isRight);
    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    assert.ok(failures[0] instanceof PtyServiceError);
    assert.equal(failures[0]?.code, 'session_already_attached');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

function delayedAttachBackend(onAttach: () => void): PtyBackendShape {
  return {
    name: 'node_pty',
    available: Effect.succeed(true),
    launch: (input) =>
      Effect.succeed({
        schemaVersion: 1,
        backend: 'node_pty',
        ptyProcessId: input.ptyProcessId,
        pid: 1234,
      }),
    attach: () =>
      Effect.async((resume) => {
        onAttach();
        const timer = setTimeout(() => {
          resume(
            Effect.succeed({
              write: () => Effect.void,
              resize: () => Effect.void,
              detach: Effect.void,
            }),
          );
        }, 25);
        return Effect.sync(() => clearTimeout(timer));
      }),
    replay: (input) =>
      Effect.sync(() => {
        input.send({ type: 'replay_start', bytes: 0 });
        input.send({ type: 'replay_end' });
      }),
    inspect: () => Effect.succeed({ status: 'alive' }),
    listSessions: Effect.succeed([]),
    kill: () => Effect.void,
  } satisfies PtyBackendShape;
}
