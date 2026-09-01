import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Layer } from 'effect';

import { DataDirectory, RuntimeDatabaseLive } from '../persistence/index.js';
import { makeTestDataDirectory } from '../persistence/test-support.js';
import {
  publishOnlyRecordingEventBus,
  type RecordingEventBus,
} from '../runtime-events/test-support.js';
import { PtyRepository, PtyRepositoryLive, type PtyRepositoryService } from './pty.repository.js';
import { transitionProcessAndPublish, transitionProcessByIdAndPublish } from './service/events.js';

// A PTY row dies exactly once. These tests pin the two halves of that guarantee:
// the first persisted terminal status rejects every later write, and a rejected
// write is *observably* a no-op — no lifecycle event, and the caller receives the
// fact that actually stands rather than the one it asked for.

function repositoryLayer(dataRoot: string) {
  const directory = Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot));
  const database = RuntimeDatabaseLive.pipe(Layer.provide(directory));
  return PtyRepositoryLive.pipe(Layer.provide(database));
}

function withRepository<A, E>(
  body: (bus: RecordingEventBus) => Effect.Effect<A, E, PtyRepositoryService>,
) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-transitions-'));
  const bus = publishOnlyRecordingEventBus('transition tests do not subscribe');
  return Effect.runPromise(
    Effect.scoped(body(bus).pipe(Effect.provide(repositoryLayer(dataRoot)))),
  ).finally(() => {
    rmSync(dataRoot, { recursive: true, force: true });
  });
}

function seedRunningProcess() {
  return Effect.gen(function* () {
    const repository = yield* PtyRepository;
    const id = yield* repository.createProcessMetadata({
      command: 'pnpm',
      args: ['dev'],
      cwd: '/repo/isagi',
    });
    yield* repository.transitionProcess({ ptyProcessId: id, status: 'running' });
    return id;
  });
}

test('a transition onto a nonterminal row applies and returns the written row', async () => {
  await withRepository(() =>
    Effect.gen(function* () {
      const repository = yield* PtyRepository;
      const id = yield* seedRunningProcess();

      const result = yield* repository.transitionProcess({
        ptyProcessId: id,
        status: 'exited',
        exitCode: 0,
      });

      assert.equal(result.applied, true);
      assert.equal(result.row?.status, 'exited');
      assert.equal(result.row?.exitCode, 0);
      assert.notEqual(result.row?.exitedAt, null);
    }),
  );
});

test('a terminal row rejects a later non-terminal transition and returns the persisted fact', async () => {
  await withRepository(() =>
    Effect.gen(function* () {
      const repository = yield* PtyRepository;
      const id = yield* seedRunningProcess();
      yield* repository.transitionProcess({ ptyProcessId: id, status: 'exited', exitCode: 0 });

      // The launch flow's post-spawn `running` write against an already-exited
      // row. Before immutability this erased the exit entirely.
      const result = yield* repository.transitionProcess({ ptyProcessId: id, status: 'running' });

      assert.equal(result.applied, false);
      assert.equal(result.row?.status, 'exited');
      assert.equal(result.row?.exitCode, 0);
      const persisted = yield* repository.findProcess(id);
      assert.equal(persisted?.status, 'exited');
    }),
  );
});

test('a terminal row rejects a later terminal transition — it died exactly once', async () => {
  await withRepository(() =>
    Effect.gen(function* () {
      const repository = yield* PtyRepository;
      const id = yield* seedRunningProcess();
      yield* repository.transitionProcess({ ptyProcessId: id, status: 'exited', exitCode: 0 });

      // A deferred `killed` retry racing an already-persisted exit: the first
      // terminal fact owns the outcome, so causality is not decided by whichever
      // write happened to land second.
      const result = yield* repository.transitionProcess({
        ptyProcessId: id,
        status: 'killed',
        statusReason: 'user_requested',
      });

      assert.equal(result.applied, false);
      assert.equal(result.row?.status, 'exited');
      assert.equal(result.row?.statusReason, null);
    }),
  );
});

test('a transition against a missing row is rejected with no row rather than silently succeeding', async () => {
  await withRepository(() =>
    Effect.gen(function* () {
      const repository = yield* PtyRepository;

      const result = yield* repository.transitionProcess({
        ptyProcessId: 9_999,
        status: 'running',
      });

      assert.deepEqual(result, { applied: false, row: null });
    }),
  );
});

test('a rejected transition publishes no lifecycle event', async () => {
  await withRepository((bus) =>
    Effect.gen(function* () {
      const repository = yield* PtyRepository;
      const id = yield* seedRunningProcess();
      const exited = yield* repository.findProcess(id);
      assert.ok(exited);
      yield* repository.transitionProcess({ ptyProcessId: id, status: 'exited', exitCode: 0 });

      // Both helpers, because both used to publish the *requested* status
      // regardless of what the row write actually did — and PTY events are shared
      // facts other domains derive process state from.
      const byRow = yield* transitionProcessAndPublish(repository, bus.service, exited, {
        ptyProcessId: id,
        status: 'running',
      });
      const byId = yield* transitionProcessByIdAndPublish(repository, bus.service, {
        ptyProcessId: id,
        status: 'killed',
        statusReason: 'user_requested',
      });

      assert.equal(byRow.applied, false);
      assert.equal(byId.applied, false);
      assert.deepEqual(bus.events, []);
    }),
  );
});

test('an applied, materially changed transition still publishes', async () => {
  await withRepository((bus) =>
    Effect.gen(function* () {
      const repository = yield* PtyRepository;
      const id = yield* seedRunningProcess();

      const result = yield* transitionProcessByIdAndPublish(repository, bus.service, {
        ptyProcessId: id,
        status: 'killed',
        statusReason: 'runtime_shutdown',
      });

      assert.equal(result.applied, true);
      assert.deepEqual(bus.events, [
        {
          type: 'pty_process_killed',
          ptyProcessId: id,
          status: 'killed',
          statusReason: 'runtime_shutdown',
        },
      ]);
    }),
  );
});

test('an applied but immaterial transition publishes nothing', async () => {
  await withRepository((bus) =>
    Effect.gen(function* () {
      const repository = yield* PtyRepository;
      const id = yield* seedRunningProcess();

      // The poller re-confirming a still-running row: the write applies, but
      // nothing about the row's meaning changed.
      const result = yield* transitionProcessByIdAndPublish(repository, bus.service, {
        ptyProcessId: id,
        status: 'running',
        statusReason: null,
      });

      assert.equal(result.applied, true);
      assert.deepEqual(bus.events, []);
    }),
  );
});
