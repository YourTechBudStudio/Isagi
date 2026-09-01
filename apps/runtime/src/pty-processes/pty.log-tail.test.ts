import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { Effect, Exit, Layer } from 'effect';

import { UserShell, type UserShellService } from '../host-inventory/user-shell.service.js';
import { DataDirectory, RuntimeDatabaseLive } from '../persistence/index.js';
import { makeTestDataDirectory } from '../persistence/test-support.js';
import { InternalRuntimeEventBusLive } from '../runtime-events/index.js';
import { PtyBackendCatalog } from './backend.js';
import { PtyForegroundStateLive } from './foreground-state.js';
import { PtyRepository, PtyRepositoryLive } from './pty.repository.js';
import { PtyService, PtyServiceLive } from './pty.service.js';
import { fakeBackendCatalog } from './test-support.js';
import { PtyServiceError, type PtyBackend as PtyBackendShape } from './types.js';

/**
 * The bounded startup-output read.
 *
 * Two facts it must keep apart, because only one of them is worth a retry:
 * "this incarnation retained nothing" is an answer, and "its log exists and
 * could not be read" is a failure. A third — "no such process" — is neither,
 * and must not be answered as if the process had simply kept no output.
 */

function testUserShell(): UserShellService {
  return {
    environment: {
      _tag: 'Available' as const,
      values: { HOME: '/home/developer', PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' },
    },
    run: () => Effect.die('log-tail tests do not run user-shell commands.'),
  };
}

// The tail reads a row and a file. No adapter is ever consulted, which is the
// point: it works for an incarnation whose process is long gone.
function unusedBackend(name: 'node_pty' | 'tmux'): PtyBackendShape {
  return {
    name,
    available: Effect.succeed(true),
    launch: () => Effect.die(`log-tail tests never launch (${name})`),
    writeInput: () => Effect.die(`log-tail tests never write (${name})`),
    attach: () => Effect.die(`log-tail tests never attach (${name})`),
    replay: () => Effect.die(`log-tail tests never replay (${name})`),
    inspect: () => Effect.succeed({ status: 'alive' as const }),
    listSessions: Effect.succeed([]),
    kill: () => Effect.succeed({ terminated: true }),
  };
}

function serviceLayer(dataRoot: string) {
  const directory = Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot));
  const database = RuntimeDatabaseLive.pipe(Layer.provide(directory));
  const repository = PtyRepositoryLive.pipe(Layer.provide(database));
  const service = PtyServiceLive.pipe(
    Layer.provide(repository),
    Layer.provide(
      Layer.succeed(
        PtyBackendCatalog,
        fakeBackendCatalog({
          configured: 'node_pty',
          nodePty: unusedBackend('node_pty'),
          tmux: unusedBackend('tmux'),
        }),
      ),
    ),
    Layer.provide(PtyForegroundStateLive),
    Layer.provide(directory),
    Layer.provide(InternalRuntimeEventBusLive),
    Layer.provide(Layer.succeed(UserShell, testUserShell())),
  );
  return Layer.mergeAll(database, repository, service);
}

// Seeds a row whose backend metadata points at `logPath`, without running a
// backend: the tail reads the row's own columns and the file, and nothing else.
function withSeededRow<A, E>(
  dataRoot: string,
  metadata: { readonly logMode: 'none' | 'backend_file'; readonly logPath: string | null },
  body: (ptyProcessId: number) => Effect.Effect<A, E, PtyService>,
) {
  return Effect.gen(function* () {
    const repository = yield* PtyRepository;
    const ptyProcessId = yield* repository.createProcessMetadata({
      command: 'code-server',
      args: [],
      cwd: '/repo/isagi',
    });
    yield* repository.updateBackendMetadata({
      ptyProcessId,
      backend: 'node_pty',
      backendRefJson: JSON.stringify({
        schemaVersion: 1,
        backend: 'node_pty',
        ptyProcessId,
        pid: 4242,
      }),
      logMode: metadata.logMode,
      logPath: metadata.logPath,
    });
    return yield* body(ptyProcessId);
  }).pipe(Effect.provide(serviceLayer(dataRoot)));
}

function withDataRoot<A>(label: string, body: (dataRoot: string) => Promise<A>) {
  const dataRoot = mkdtempSync(join(tmpdir(), `isagi-pty-tail-${label}-`));
  return body(dataRoot).finally(() => rmSync(dataRoot, { recursive: true, force: true }));
}

test('a tail returns the last bytes and reports truncation honestly', async () => {
  await withDataRoot('bounded', async (dataRoot) => {
    const logPath = join(dataRoot, 'startup.ptylog');
    writeFileSync(logPath, 'abcdefghij');

    const result = await Effect.runPromise(
      withSeededRow(dataRoot, { logMode: 'backend_file', logPath }, (ptyProcessId) =>
        Effect.gen(function* () {
          const service = yield* PtyService;
          return {
            bounded: yield* service.readLogTail({ ptyProcessId, maxBytes: 4 }),
            whole: yield* service.readLogTail({ ptyProcessId, maxBytes: 1024 }),
          };
        }),
      ),
    );

    assert.deepEqual(result.bounded, { excerpt: 'ghij', truncated: true, totalBytes: 10 });
    assert.deepEqual(result.whole, { excerpt: 'abcdefghij', truncated: false, totalBytes: 10 });
  });
});

test('a bound that splits a multi-byte character drops it rather than mangling it', async () => {
  await withDataRoot('utf8', async (dataRoot) => {
    const logPath = join(dataRoot, 'startup.ptylog');
    // Three-byte characters, so a bound of 4 lands inside the second one.
    const content = '日本語';
    writeFileSync(logPath, content);
    assert.equal(Buffer.byteLength(content, 'utf8'), 9);

    const tail = await Effect.runPromise(
      withSeededRow(dataRoot, { logMode: 'backend_file', logPath }, (ptyProcessId) =>
        Effect.gen(function* () {
          const service = yield* PtyService;
          return yield* service.readLogTail({ ptyProcessId, maxBytes: 4 });
        }),
      ),
    );

    // The truncation artefact a naive seek would produce is exactly what must
    // not appear: the excerpt is a whole character short, never a replacement.
    assert.equal(tail.excerpt, '語');
    assert.ok(!tail.excerpt?.includes('�'));
    assert.equal(tail.truncated, true);
    assert.equal(tail.totalBytes, 9);
  });
});

test('a zero bound yields an empty excerpt over a non-empty log', async () => {
  await withDataRoot('zero', async (dataRoot) => {
    const logPath = join(dataRoot, 'startup.ptylog');
    writeFileSync(logPath, 'output');

    const tail = await Effect.runPromise(
      withSeededRow(dataRoot, { logMode: 'backend_file', logPath }, (ptyProcessId) =>
        Effect.gen(function* () {
          const service = yield* PtyService;
          return yield* service.readLogTail({ ptyProcessId, maxBytes: 0 });
        }),
      ),
    );

    assert.deepEqual(tail, { excerpt: '', truncated: true, totalBytes: 6 });
  });
});

test('an empty log reads as retained and empty, not as nothing retained', async () => {
  await withDataRoot('empty', async (dataRoot) => {
    const logPath = join(dataRoot, 'startup.ptylog');
    writeFileSync(logPath, '');

    const tail = await Effect.runPromise(
      withSeededRow(dataRoot, { logMode: 'backend_file', logPath }, (ptyProcessId) =>
        Effect.gen(function* () {
          const service = yield* PtyService;
          return yield* service.readLogTail({ ptyProcessId, maxBytes: 1024 });
        }),
      ),
    );

    assert.deepEqual(tail, { excerpt: '', truncated: false, totalBytes: 0 });
  });
});

test('a row that retains no log answers rather than failing', async () => {
  await withDataRoot('none', async (dataRoot) => {
    const missingPath = join(dataRoot, 'never-written.ptylog');

    const result = await Effect.runPromise(
      Effect.all([
        withSeededRow(dataRoot, { logMode: 'none', logPath: null }, (ptyProcessId) =>
          Effect.gen(function* () {
            const service = yield* PtyService;
            return yield* service.readLogTail({ ptyProcessId, maxBytes: 1024 });
          }),
        ),
        // The row outlived its file: an allocation abandoned before the backend
        // wrote one, or the orphan-log sweep.
        withSeededRow(dataRoot, { logMode: 'backend_file', logPath: missingPath }, (ptyProcessId) =>
          Effect.gen(function* () {
            const service = yield* PtyService;
            return yield* service.readLogTail({ ptyProcessId, maxBytes: 1024 });
          }),
        ),
      ]),
    );

    for (const tail of result) {
      assert.deepEqual(tail, { excerpt: null, truncated: false, totalBytes: null });
    }
  });
});

test(
  'an existing but unreadable log fails rather than reading as empty',
  {
    // Permission bits do not constrain root, so the fixture cannot be built there.
    skip: process.getuid?.() === 0 ? 'requires a non-root user' : false,
  },
  async () => {
    await withDataRoot('unreadable', async (dataRoot) => {
      const logPath = join(dataRoot, 'startup.ptylog');
      writeFileSync(logPath, 'output');
      chmodSync(logPath, 0o000);

      const exit = await Effect.runPromiseExit(
        withSeededRow(dataRoot, { logMode: 'backend_file', logPath }, (ptyProcessId) =>
          Effect.gen(function* () {
            const service = yield* PtyService;
            return yield* service.readLogTail({ ptyProcessId, maxBytes: 1024 });
          }),
        ),
      );

      chmodSync(logPath, 0o600);
      assert.ok(Exit.isFailure(exit));
      const failure = Exit.isFailure(exit)
        ? (exit.cause as { readonly error?: unknown }).error
        : null;
      assert.ok(failure instanceof PtyServiceError);
      assert.equal(failure.code, 'log_read_failed');
    });
  },
);

test('an unknown process is not answered as a process that retained nothing', async () => {
  await withDataRoot('missing-row', async (dataRoot) => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const service = yield* PtyService;
        return yield* service.readLogTail({ ptyProcessId: 9999, maxBytes: 1024 });
      }).pipe(Effect.provide(serviceLayer(dataRoot))),
    );

    assert.ok(Exit.isFailure(exit));
    const failure = (exit.cause as { readonly error?: unknown }).error;
    assert.ok(failure instanceof PtyServiceError);
    assert.equal(failure.code, 'session_not_found');
  });
});

test('an invalid bound is a defect, not an expected failure', async () => {
  await withDataRoot('defect', async (dataRoot) => {
    // A caller-side bug. Clamping would hide it, and a tagged member would widen
    // the channel every consumer handles for a case that cannot occur.
    for (const maxBytes of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const exit = await Effect.runPromiseExit(
        withSeededRow(dataRoot, { logMode: 'none', logPath: null }, (ptyProcessId) =>
          Effect.gen(function* () {
            const service = yield* PtyService;
            return yield* service.readLogTail({ ptyProcessId, maxBytes });
          }),
        ),
      );
      assert.ok(Exit.isFailure(exit), `maxBytes=${String(maxBytes)} must not succeed`);
      assert.ok(
        JSON.stringify(exit.cause).includes('Die') ||
          String(exit.cause).includes('non-negative safe integer'),
        `maxBytes=${String(maxBytes)} must fail as a defect`,
      );
    }
  });
});
