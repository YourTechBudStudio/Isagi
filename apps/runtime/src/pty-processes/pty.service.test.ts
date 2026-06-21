import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Either, Layer } from 'effect';

import { DataDirectory, RuntimeDatabaseLive } from '../persistence/index.js';
import { makeTestDataDirectory } from '../persistence/test-support.js';
import { InternalRuntimeEventBusLive } from '../runtime-events/index.js';
import { PtyBackend } from './backend.js';
import { PtyForegroundStateLive } from './foreground-state.js';
import { PtyRepository, PtyRepositoryLive } from './pty.repository.js';
import { PtyService, PtyServiceLive } from './pty.service.js';
import { PtyServiceError, type PtyBackend as PtyBackendShape } from './types.js';

function dataDirectoryLayer(dataRoot: string) {
  const dataDirectory = makeTestDataDirectory(dataRoot);
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
            pty
              .attach({
                ptyProcessId: process.ptyProcessId,
                mode: 'interactive',
                send: () => {},
              })
              .pipe(Effect.either),
            pty
              .attach({
                ptyProcessId: process.ptyProcessId,
                mode: 'interactive',
                send: () => {},
              })
              .pipe(Effect.either),
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

test('PTY read-only attachments expose no writable attachment id', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-process-read-only-'));
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const pty = yield* PtyService;
        const process = yield* pty.launch({ command: 'bash', args: [], cwd: '/repo/isagi' });
        const attachment = yield* pty.attach({
          ptyProcessId: process.ptyProcessId,
          mode: 'read_only',
          send: () => {},
        });
        const writeResult = yield* pty
          .write({
            ptyProcessId: process.ptyProcessId,
            attachmentId: attachment.attachmentId,
            data: 'nope',
          })
          .pipe(Effect.either);
        return { attachment, writeResult };
      }).pipe(
        Effect.provide(
          serviceTestLayer(
            dataRoot,
            delayedAttachBackend(() => {}),
          ),
        ),
      ),
    );

    assert.equal(result.attachment.attachmentId, null);
    assert.equal(Either.isLeft(result.writeResult), true);
    if (Either.isLeft(result.writeResult)) {
      assert.equal(result.writeResult.left instanceof PtyServiceError, true);
      if (result.writeResult.left instanceof PtyServiceError) {
        assert.equal(result.writeResult.left.code, 'session_not_running');
      }
    }
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('PTY read-only supersede awaits displaced detach before replacement attach', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-process-read-only-supersede-'));
  const events: string[] = [];
  const backend = singleAttachmentBackend(events);
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const pty = yield* PtyService;
        const process = yield* pty.launch({ command: 'bash', args: [], cwd: '/repo/isagi' });
        yield* pty.attach({
          ptyProcessId: process.ptyProcessId,
          mode: 'read_only',
          supersede: true,
          send: () => {},
          displace: (attachment) =>
            Effect.gen(function* () {
              events.push('displace');
              yield* attachment.detach;
            }),
        });
        yield* pty.attach({
          ptyProcessId: process.ptyProcessId,
          mode: 'read_only',
          supersede: true,
          send: () => {},
          displace: (attachment) =>
            Effect.gen(function* () {
              events.push('replacement-displace');
              yield* attachment.detach;
            }),
        });
      }).pipe(Effect.provide(serviceTestLayer(dataRoot, backend))),
    );

    assert.deepEqual(events.slice(0, 4), ['attach', 'displace', 'detach', 'attach']);
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
              replayBytes: 0,
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

function singleAttachmentBackend(events: string[]): PtyBackendShape {
  let attached = false;
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
      Effect.sync(() => {
        if (attached) throw new Error('already attached');
        attached = true;
        events.push('attach');
        return {
          replayBytes: 0,
          write: () => Effect.void,
          resize: () => Effect.void,
          detach: Effect.sync(() => {
            if (!attached) return;
            attached = false;
            events.push('detach');
          }),
        };
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
