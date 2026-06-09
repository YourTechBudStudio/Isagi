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
import { WorkspaceRepository, WorkspaceRepositoryLive } from '../workspace/index.js';
import {
  SurfaceError,
  SurfaceRepositoryLive,
  SurfaceService,
  SurfaceServiceLive,
} from './index.js';

test('single-pane surface creation persists duplicate-safe titles and one-leaf layout', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-data-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const first = yield* surfaces.createSinglePaneSurface({
          worktreeId,
          kind: 'agent',
          titleBase: 'Pi',
        });
        const second = yield* surfaces.createSinglePaneSurface({
          worktreeId,
          kind: 'agent',
          titleBase: 'Pi',
        });
        return {
          first,
          second,
          detail: yield* surfaces.getSurfaceDetail(first.surfaceId),
        };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(output.first.title, 'Pi');
    assert.equal(output.second.title, 'Pi 2');
    assert.deepEqual(output.detail.layout, {
      kind: 'leaf',
      nodeId: `pane-${output.first.paneId}`,
      paneId: output.first.paneId,
      collapsed: false,
    });
    assert.equal(output.detail.panes[0]?.id, output.first.paneId);
    assert.equal(output.detail.panes[0]?.ptySession, null);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('environment focus persists active pane only when it belongs to the active surface', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-focus-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const first = yield* surfaces.createSinglePaneSurface({
          worktreeId,
          kind: 'terminal',
          titleBase: 'Terminal',
        });
        const second = yield* surfaces.createSinglePaneSurface({
          worktreeId,
          kind: 'terminal',
          titleBase: 'Terminal',
        });

        yield* surfaces.setWorktreeEnvironmentFocus({
          worktreeId,
          focus: { activeSurfaceId: first.surfaceId, activePaneId: first.paneId },
        });

        return {
          firstDetail: yield* surfaces.getSurfaceDetail(first.surfaceId),
          secondDetail: yield* surfaces.getSurfaceDetail(second.surfaceId),
        };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(output.firstDetail.activePaneId, output.firstDetail.panes[0]?.id);
    assert.equal(output.secondDetail.activePaneId, null);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('environment focus rejects panes that do not belong to the selected surface', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-invalid-focus-'));
  try {
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          const worktreeId = yield* insertWorktree('/repo/isagi');
          const surfaces = yield* SurfaceService;
          const first = yield* surfaces.createSinglePaneSurface({
            worktreeId,
            kind: 'terminal',
            titleBase: 'Terminal',
          });
          const second = yield* surfaces.createSinglePaneSurface({
            worktreeId,
            kind: 'terminal',
            titleBase: 'Terminal',
          });

          return yield* surfaces.setWorktreeEnvironmentFocus({
            worktreeId,
            focus: { activeSurfaceId: first.surfaceId, activePaneId: second.paneId },
          });
        }).pipe(Effect.provide(testLayer(dataRoot))),
      ),
    );

    assert.ok(error instanceof SurfaceError);
    assert.equal(error.code, 'pane_not_found');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

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
  const workspaceRepository = WorkspaceRepositoryLive.pipe(Layer.provide(database));
  const surfaceRepository = SurfaceRepositoryLive.pipe(
    Layer.provide(database),
    Layer.provide(dataDirectoryLayer),
  );
  const surfaceService = SurfaceServiceLive.pipe(Layer.provide(surfaceRepository));
  return Layer.mergeAll(workspaceRepository, surfaceRepository, surfaceService);
}
