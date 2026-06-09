import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Layer } from 'effect';

import type { SurfaceDetail } from '@isagi/contracts';

import {
  DataDirectory,
  RuntimeDatabaseLive,
  type DataDirectoryService,
} from '../persistence/index.js';
import { SurfaceRepositoryLive, SurfaceService, SurfaceServiceLive } from '../surfaces/index.js';
import { WorkspaceRepository, WorkspaceRepositoryLive } from '../workspace/index.js';
import {
  PtyAdapter,
  PtyRepository,
  PtyRepositoryLive,
  PtyService,
  PtyServiceLive,
  PtyStartError,
  type PtyAdapterShape,
  type PtyStartInput,
} from './index.js';

test('launch creates metadata, writes output to the log, and marks running attention', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-launch-'));
  const fake = fakeAdapter();
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const pty = yield* PtyService;
        const launched = yield* pty.launch({ worktreeId, purpose: 'terminal', harness: null });
        const surfaces = yield* SurfaceService;
        return { launched, detail: yield* surfaces.getSurfaceDetail(launched.surfaceId) };
      }).pipe(Effect.provide(testLayer(dataRoot, fake.adapter))),
    );

    assert.equal(output.launched.worktreeId, output.detail.worktreeId);
    assert.equal(output.detail.attention, 'working');
    assert.equal(output.detail.panes[0]?.attention, 'working');
    assert.equal(output.detail.panes[0]?.ptySession?.status, 'running');
    assert.equal(output.detail.panes[0]?.ptySession?.command, process.env.SHELL || 'bash');
    assert.ok(
      readFileSync(
        join(dataRoot, 'sessions', `${output.launched.ptySessionId}.ptylog`),
        'utf8',
      ).startsWith('hello from pty'),
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('spawn failure returns created ids and persists a failed visible session with log text', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-failed-spawn-'));
  const fake = fakeAdapter({ failStart: true });
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const pty = yield* PtyService;
        const launched = yield* pty.launch({ worktreeId, purpose: 'agent', harness: 'pi' });
        const surfaces = yield* SurfaceService;
        return { launched, detail: yield* surfaces.getSurfaceDetail(launched.surfaceId) };
      }).pipe(Effect.provide(testLayer(dataRoot, fake.adapter))),
    );

    assert.equal(output.detail.title, 'Pi');
    assert.equal(output.detail.attention, 'error');
    assert.equal(output.detail.panes[0]?.ptySession?.status, 'failed');
    assert.equal(output.detail.panes[0]?.ptySession?.command, 'pi');
    const log = readFileSync(
      join(dataRoot, 'sessions', `${output.launched.ptySessionId}.ptylog`),
      'utf8',
    );
    assert.match(log, /Failed to start pi/);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('exit updates status and attention honestly', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-exit-'));
  const fake = fakeAdapter();
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const pty = yield* PtyService;
        const launched = yield* pty.launch({ worktreeId, purpose: 'terminal', harness: null });
        fake.exits.get(launched.ptySessionId)?.({ exitCode: 1, signal: null });
        yield* waitUntilDetail(
          launched.surfaceId,
          (detail) => detail.panes[0]?.ptySession?.status === 'failed',
        );
        const surfaces = yield* SurfaceService;
        return { launched, detail: yield* surfaces.getSurfaceDetail(launched.surfaceId) };
      }).pipe(Effect.provide(testLayer(dataRoot, fake.adapter))),
    );

    assert.equal(output.detail.attention, 'error');
    assert.equal(output.detail.panes[0]?.ptySession?.exitCode, 1);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('attach captures replay offset before live output so replay and live stream do not gap', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-attach-'));
  const fake = fakeAdapter();
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const pty = yield* PtyService;
        const launched = yield* pty.launch({ worktreeId, purpose: 'terminal', harness: null });
        const messages: unknown[] = [];
        const attachment = yield* pty.attach({
          ptySessionId: launched.ptySessionId,
          send: (message) => messages.push(message),
        });
        fake.outputs.get(launched.ptySessionId)?.('during replay');
        const replayed: unknown[] = [];
        yield* pty.replay({
          session: attachment.session,
          bytes: attachment.replayOffset,
          send: (message) => replayed.push(message),
        });
        attachment.unsubscribe();
        return { launched, messages, replayed };
      }).pipe(Effect.provide(testLayer(dataRoot, fake.adapter))),
    );

    assert.deepEqual(output.replayed, [
      { type: 'replay_start', bytes: Buffer.byteLength('hello from pty') },
      { type: 'output', data: 'hello from pty', replay: true },
      { type: 'replay_end' },
    ]);
    assert.deepEqual(output.messages, [{ type: 'output', data: 'during replay' }]);
    assert.ok(
      readFileSync(
        join(dataRoot, 'sessions', `${output.launched.ptySessionId}.ptylog`),
        'utf8',
      ).startsWith('hello from ptyduring replay'),
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('startup recovery marks persisted live sessions failed with a synthetic log note', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-restart-'));
  try {
    const launched = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const repository = yield* PtyRepository;
        const metadata = yield* repository.createLaunchMetadata({
          worktreeId,
          kind: 'terminal',
          titleBase: 'Terminal',
          purpose: 'terminal',
          harness: null,
          command: process.env.SHELL || 'bash',
        });
        return {
          worktreeId: metadata.worktreeId,
          surfaceId: metadata.surfaceId,
          paneId: metadata.paneId,
          ptySessionId: metadata.ptySessionId,
        };
      }).pipe(Effect.provide(repositoryOnlyLayer(dataRoot))),
    );

    const recovered = await Effect.runPromise(
      Effect.gen(function* () {
        const surfaces = yield* SurfaceService;
        return yield* surfaces.getSurfaceDetail(launched.surfaceId);
      }).pipe(Effect.provide(testLayer(dataRoot, fakeAdapter().adapter))),
    );

    assert.equal(recovered.panes[0]?.ptySession?.status, 'failed');
    const log = readFileSync(join(dataRoot, 'sessions', `${launched.ptySessionId}.ptylog`), 'utf8');
    assert.match(log, /Runtime restarted; this session is no longer live\./);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

function fakeAdapter(options: { readonly failStart?: boolean } = {}) {
  let nextPid = 100;
  const outputs = new Map<number, (data: string) => void>();
  const exits = new Map<
    number,
    (exit: { readonly exitCode: number | null; readonly signal: string | null }) => void
  >();
  const adapter = {
    name: 'node_pty',
    start: (input: PtyStartInput) =>
      Effect.try({
        try: () => {
          if (options.failStart) {
            throw new Error('spawn failed');
          }
          const pid = nextPid++;
          outputs.set(pid - 100 + 1, input.onOutput);
          exits.set(pid - 100 + 1, input.onExit);
          input.onOutput('hello from pty');
          return { pid };
        },
        catch: (cause) => new PtyStartError({ command: input.command, cwd: input.cwd, cause }),
      }),
    write: () => Effect.void,
    resize: () => Effect.void,
    kill: () => Effect.void,
  } satisfies PtyAdapterShape;
  return { adapter, outputs, exits };
}

function insertWorktree(rootPath: string) {
  return Effect.gen(function* () {
    const workspaceRepository = yield* WorkspaceRepository;
    const projectId = yield* workspaceRepository.insertProject({ name: 'isagi', rootPath });
    yield* workspaceRepository.reconcileProjectWorktrees({
      projectId,
      discovered: [{ path: rootPath, branch: 'main', head: 'abcdef0' }],
    });
    const worktrees = yield* workspaceRepository.listWorktrees;
    const worktree = worktrees.find((candidate) => candidate.projectId === projectId);
    if (!worktree) {
      return yield* Effect.die('Expected test worktree to be inserted.');
    }
    return worktree.id;
  });
}

function waitUntilDetail(surfaceId: number, predicate: (detail: SurfaceDetail) => boolean) {
  return Effect.gen(function* () {
    const surfaces = yield* SurfaceService;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const detail = yield* surfaces.getSurfaceDetail(surfaceId);
      if (predicate(detail)) {
        return detail;
      }
      yield* Effect.sleep('10 millis');
    }
    return yield* Effect.die('Timed out waiting for surface detail predicate.');
  });
}

function repositoryOnlyLayer(dataRoot: string) {
  const dataDirectory = dataDirectoryService(dataRoot);
  const dataDirectoryLayer = Layer.succeed(DataDirectory, dataDirectory);
  const database = RuntimeDatabaseLive.pipe(Layer.provide(dataDirectoryLayer));
  const workspaceRepository = WorkspaceRepositoryLive.pipe(Layer.provide(database));
  const surfaceRepository = SurfaceRepositoryLive.pipe(
    Layer.provide(database),
    Layer.provide(dataDirectoryLayer),
  );
  const ptyRepository = PtyRepositoryLive.pipe(
    Layer.provide(database),
    Layer.provide(surfaceRepository),
  );
  return Layer.mergeAll(workspaceRepository, surfaceRepository, ptyRepository);
}

function testLayer(dataRoot: string, adapter: PtyAdapterShape) {
  const dataDirectory = dataDirectoryService(dataRoot);

  const dataDirectoryLayer = Layer.succeed(DataDirectory, dataDirectory);
  const database = RuntimeDatabaseLive.pipe(Layer.provide(dataDirectoryLayer));
  const workspaceRepository = WorkspaceRepositoryLive.pipe(Layer.provide(database));
  const surfaceRepository = SurfaceRepositoryLive.pipe(
    Layer.provide(database),
    Layer.provide(dataDirectoryLayer),
  );
  const surfaceService = SurfaceServiceLive.pipe(Layer.provide(surfaceRepository));
  const ptyRepository = PtyRepositoryLive.pipe(
    Layer.provide(database),
    Layer.provide(surfaceRepository),
  );
  const ptyService = PtyServiceLive.pipe(
    Layer.provide(ptyRepository),
    Layer.provide(Layer.succeed(PtyAdapter, adapter)),
    Layer.provide(dataDirectoryLayer),
  );
  return Layer.mergeAll(
    workspaceRepository,
    surfaceRepository,
    surfaceService,
    ptyRepository,
    ptyService,
  );
}

function dataDirectoryService(dataRoot: string) {
  return {
    paths: {
      root: dataRoot,
      databasePath: join(dataRoot, 'isagi.db'),
      statePath: join(dataRoot, 'state.json'),
      worktreesPath: join(dataRoot, 'worktrees'),
      sessionsPath: join(dataRoot, 'sessions'),
    },
  } satisfies DataDirectoryService;
}
