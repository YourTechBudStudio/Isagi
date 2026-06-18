import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Layer } from 'effect';

import {
  DataDirectory,
  RuntimeDatabaseLive,
  type DataDirectoryService,
} from '../persistence/index.js';
import { PtyRepository, PtyRepositoryLive } from './pty.repository.js';

function testLayer(dataRoot: string) {
  const dataDirectory = {
    paths: {
      root: dataRoot,
      databasePath: join(dataRoot, 'isagi.db'),
      statePath: join(dataRoot, 'state.json'),
      worktreesPath: join(dataRoot, 'worktrees'),
      sessionsPath: join(dataRoot, 'sessions'),
    },
  } satisfies DataDirectoryService;
  const dataDirectoryLayer = Layer.succeed(DataDirectory, dataDirectory);
  const database = RuntimeDatabaseLive.pipe(Layer.provide(dataDirectoryLayer));
  const repository = PtyRepositoryLive.pipe(Layer.provide(database));
  return Layer.mergeAll(database, repository);
}

test('PTY process repository lists process log paths for cleanup scans', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-process-log-paths-'));
  try {
    const paths = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* PtyRepository;
        const id = yield* repository.createProcessMetadata({
          command: 'bash',
          args: [],
          cwd: '/repo/isagi',
        });
        yield* repository.updateBackendMetadata({
          ptyProcessId: id,
          backend: 'node_pty',
          backendRefJson: JSON.stringify({
            schemaVersion: 1,
            backend: 'node_pty',
            ptyProcessId: id,
            pid: null,
          }),
          logMode: 'backend_file',
          logPath: join(dataRoot, 'sessions', `${id}.ptylog`),
        });
        return yield* repository.listProcessLogPaths;
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(paths.length, 1);
    assert.match(paths[0] ?? '', /\.ptylog$/);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
