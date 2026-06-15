import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { Effect, Either, Layer } from 'effect';

import type { SurfaceDeleteWarning } from '@isagi/contracts';

import {
  DataDirectory,
  RuntimeDatabase,
  RuntimeDatabaseLive,
  type DataDirectoryService,
} from '../persistence/index.js';
import { ptySessions, surfacePanes, worktreeSurfaces } from '../persistence/schema.js';
import { PtyService, type PtyServiceShape } from '../pty/index.js';
import { WorkspaceRepository, WorkspaceRepositoryLive } from '../workspace/index.js';
import {
  SurfaceError,
  SurfaceRepositoryLive,
  SurfaceService,
  SurfaceServiceLive,
} from './index.js';

const outputPaneIdBySession = new Map<number, number>();

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

test('rename trims surface title, allows duplicates, and leaves pane title unchanged', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-rename-'));
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
        yield* surfaces.createSinglePaneSurface({
          worktreeId,
          kind: 'terminal',
          titleBase: 'Terminal',
        });

        const renamed = yield* surfaces.renameSurface({
          surfaceId: first.surfaceId,
          title: '  Terminal 2  ',
        });
        return {
          renamed,
          detail: yield* surfaces.getSurfaceDetail(first.surfaceId),
        };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(output.renamed, {
      surfaceId: output.detail.id,
      title: 'Terminal 2',
    });
    assert.equal(output.detail.title, 'Terminal 2');
    assert.equal(output.detail.panes[0]?.title, 'Terminal');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('rename rejects empty and overlong titles', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-rename-invalid-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const surface = yield* surfaces.createSinglePaneSurface({
          worktreeId,
          kind: 'terminal',
          titleBase: 'Terminal',
        });
        const empty = yield* surfaces
          .renameSurface({ surfaceId: surface.surfaceId, title: '   ' })
          .pipe(Effect.either);
        const long = yield* surfaces
          .renameSurface({ surfaceId: surface.surfaceId, title: 'a'.repeat(81) })
          .pipe(Effect.either);
        return { empty, long };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(Either.isLeft(output.empty), true);
    assert.equal(Either.isLeft(output.long), true);
    if (Either.isLeft(output.empty)) {
      assert.ok(output.empty.left instanceof SurfaceError);
      assert.equal(output.empty.left.code, 'invalid_surface_title');
    }
    if (Either.isLeft(output.long)) {
      assert.ok(output.long.left instanceof SurfaceError);
      assert.equal(output.long.left.code, 'invalid_surface_title');
    }
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('delete pane updates layout and keeps the remaining pane', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-delete-pane-'));
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
        const secondPaneId = yield* addPaneToSurface(first.surfaceId);

        const deleted = yield* surfaces.deleteSurfacePane({
          surfaceId: first.surfaceId,
          paneId: first.paneId,
        });
        return {
          first,
          deleted,
          detail: yield* surfaces.getSurfaceDetail(first.surfaceId),
          secondPaneId,
        };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(output.deleted, {
      deletedSurfaceId: null,
      deletedPaneIds: [output.first.paneId],
      attemptedPtySessionIds: [],
      warnings: [],
    });
    assert.equal(output.deleted.deletedPaneIds.length, 1);
    assert.equal(output.detail.panes.length, 1);
    assert.equal(output.detail.panes[0]?.id, output.secondPaneId);
    assert.deepEqual(output.detail.layout, {
      kind: 'leaf',
      nodeId: `pane-${output.secondPaneId}`,
      paneId: output.secondPaneId,
      collapsed: false,
    });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('delete last pane deletes the surface and removes referenced logs', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-delete-last-pane-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const surface = yield* surfaces.createSinglePaneSurface({
          worktreeId,
          kind: 'terminal',
          titleBase: 'Terminal',
        });
        mkdirSync(join(dataRoot, 'sessions'), { recursive: true });
        const logPath = join(dataRoot, 'sessions', 'delete-last-pane.ptylog');
        writeFileSync(logPath, 'session log', 'utf8');
        const ptySessionId = yield* insertPtySession({
          paneId: surface.paneId,
          worktreeId,
          logPath,
          status: 'exited',
        });

        const deleted = yield* surfaces.deleteSurfacePane({
          surfaceId: surface.surfaceId,
          paneId: surface.paneId,
        });
        const detail = yield* surfaces.getSurfaceDetail(surface.surfaceId).pipe(Effect.either);
        return { deleted, detail, logPath, ptySessionId, surface };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(output.deleted, {
      deletedSurfaceId: output.surface.surfaceId,
      deletedPaneIds: [output.surface.paneId],
      attemptedPtySessionIds: [],
      warnings: [],
    });
    assert.equal(existsSync(output.logPath), false);
    assert.equal(Either.isLeft(output.detail), true);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('delete surface warns but still deletes rows when log deletion fails', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-delete-log-warning-'));
  const warnings: unknown[] = [];
  const originalConsoleWarn = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(message);
  };

  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const surface = yield* surfaces.createSinglePaneSurface({
          worktreeId,
          kind: 'terminal',
          titleBase: 'Terminal',
        });
        mkdirSync(join(dataRoot, 'sessions'), { recursive: true });
        const logPath = join(dataRoot, 'sessions', 'log-path-is-directory.ptylog');
        mkdirSync(logPath);
        const ptySessionId = yield* insertPtySession({
          paneId: surface.paneId,
          worktreeId,
          logPath,
          status: 'exited',
        });

        const deleted = yield* surfaces.deleteSurface(surface.surfaceId);
        const detail = yield* surfaces.getSurfaceDetail(surface.surfaceId).pipe(Effect.either);
        return { deleted, detail, logPath, ptySessionId, surface };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(output.deleted, {
      deletedSurfaceId: output.surface.surfaceId,
      deletedPaneIds: [output.surface.paneId],
      attemptedPtySessionIds: [],
      warnings: [
        {
          code: 'pty_log_delete_failed',
          paneId: output.surface.paneId,
          ptySessionId: output.ptySessionId,
        },
      ],
    });
    assert.equal(existsSync(output.logPath), true);
    assert.equal(Either.isLeft(output.detail), true);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]), /^(\[runtime\] )?Failed to delete PTY log/);
  } finally {
    console.warn = originalConsoleWarn;
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('delete surface continues after live PTY cleanup warning', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-delete-warning-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const surface = yield* surfaces.createSinglePaneSurface({
          worktreeId,
          kind: 'terminal',
          titleBase: 'Terminal',
        });
        const ptySessionId = yield* insertPtySession({
          paneId: surface.paneId,
          worktreeId,
          logPath: null,
          status: 'running',
        });

        const deleted = yield* surfaces.deleteSurface(surface.surfaceId);
        const detail = yield* surfaces.getSurfaceDetail(surface.surfaceId).pipe(Effect.either);
        return { deleted, detail, surface, ptySessionId };
      }).pipe(
        Effect.provide(
          testLayer(dataRoot, {
            cleanupWarnings: (ptySessionId) => [
              {
                code: 'pty_backend_unavailable',
                paneId: outputPaneIdBySession.get(ptySessionId) ?? 1,
                ptySessionId,
              },
            ],
          }),
        ),
      ),
    );

    assert.equal(output.deleted.deletedSurfaceId, output.surface.surfaceId);
    assert.deepEqual(output.deleted.deletedPaneIds, [output.surface.paneId]);
    assert.deepEqual(output.deleted.attemptedPtySessionIds, [output.ptySessionId]);
    assert.deepEqual(output.deleted.warnings, [
      {
        code: 'pty_backend_unavailable',
        paneId: output.surface.paneId,
        ptySessionId: output.ptySessionId,
      },
    ]);
    assert.equal(Either.isLeft(output.detail), true);
  } finally {
    outputPaneIdBySession.clear();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('delete pane cleans up every live session when invalid layout escalates to surface delete', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-delete-pane-invalid-layout-'));
  try {
    const cleanupCalls: number[] = [];
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const surface = yield* surfaces.createSinglePaneSurface({
          worktreeId,
          kind: 'terminal',
          titleBase: 'Terminal',
        });
        const secondPaneId = yield* addPaneToSurface(surface.surfaceId);
        const firstSessionId = yield* insertPtySession({
          paneId: surface.paneId,
          worktreeId,
          logPath: null,
          status: 'running',
        });
        const secondSessionId = yield* insertPtySession({
          paneId: secondPaneId,
          worktreeId,
          logPath: null,
          status: 'running',
        });
        yield* replaceSurfaceLayoutWithSingleDeletedPane(surface.surfaceId, surface.paneId);

        const deleted = yield* surfaces.deleteSurfacePane({
          surfaceId: surface.surfaceId,
          paneId: surface.paneId,
        });
        const detail = yield* surfaces.getSurfaceDetail(surface.surfaceId).pipe(Effect.either);
        return { deleted, detail, firstSessionId, secondSessionId, surface, secondPaneId };
      }).pipe(
        Effect.provide(
          testLayer(dataRoot, {
            cleanupWarnings: (ptySessionId) => {
              cleanupCalls.push(ptySessionId);
              return [];
            },
          }),
        ),
      ),
    );

    assert.deepEqual(output.deleted, {
      deletedSurfaceId: output.surface.surfaceId,
      deletedPaneIds: [output.surface.paneId, output.secondPaneId],
      attemptedPtySessionIds: [output.firstSessionId, output.secondSessionId],
      warnings: [],
    });
    assert.deepEqual(cleanupCalls, [output.firstSessionId, output.secondSessionId]);
    assert.equal(Either.isLeft(output.detail), true);
  } finally {
    outputPaneIdBySession.clear();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('cleanup worktree for delete cleans live sessions across surfaces without deleting rows', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-cleanup-worktree-'));
  try {
    const cleanupCalls: number[] = [];
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
          kind: 'agent',
          titleBase: 'Agent',
        });
        const firstSessionId = yield* insertPtySession({
          paneId: first.paneId,
          worktreeId,
          logPath: null,
          status: 'running',
        });
        const secondSessionId = yield* insertPtySession({
          paneId: second.paneId,
          worktreeId,
          logPath: null,
          status: 'starting',
        });

        const cleanup = yield* surfaces.cleanupWorktreeForDelete(worktreeId);
        const detail = yield* surfaces.getSurfaceDetail(first.surfaceId);
        return { cleanup, detail, firstSessionId, secondSessionId };
      }).pipe(
        Effect.provide(
          testLayer(dataRoot, {
            cleanupWarnings: (ptySessionId) => {
              cleanupCalls.push(ptySessionId);
              return [];
            },
          }),
        ),
      ),
    );

    assert.deepEqual(cleanupCalls, [output.firstSessionId, output.secondSessionId]);
    assert.deepEqual(output.cleanup, {
      attemptedPtySessionIds: [output.firstSessionId, output.secondSessionId],
      warnings: [],
    });
    assert.equal(output.detail.panes.length, 1);
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

function replaceSurfaceLayoutWithSingleDeletedPane(surfaceId: number, paneId: number) {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    return yield* database.use('test_replace_surface_layout_with_single_deleted_pane', (db) => {
      db.update(worktreeSurfaces)
        .set({
          layoutJson: JSON.stringify({
            kind: 'leaf',
            nodeId: `pane-${paneId}`,
            paneId,
            collapsed: false,
          }),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(worktreeSurfaces.id, surfaceId))
        .run();
    });
  });
}

function addPaneToSurface(surfaceId: number) {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    return yield* database.use('test_add_surface_pane', (db) => {
      const now = new Date().toISOString();
      const pane = db
        .insert(surfacePanes)
        .values({
          surfaceId,
          title: 'Second pane',
          attention: 'idle',
          sortOrder: 1,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: surfacePanes.id })
        .get();
      const surface = db
        .select({ layoutJson: worktreeSurfaces.layoutJson })
        .from(worktreeSurfaces)
        .where(eq(worktreeSurfaces.id, surfaceId))
        .get();
      if (!surface) {
        throw new Error(`Missing test surface ${surfaceId}.`);
      }
      const existingLayout = JSON.parse(surface.layoutJson);
      db.update(worktreeSurfaces)
        .set({
          layoutJson: JSON.stringify({
            kind: 'split',
            nodeId: `split-${surfaceId}`,
            axis: 'row',
            sizing: 'manual',
            children: [
              existingLayout,
              {
                kind: 'leaf',
                nodeId: `pane-${pane.id}`,
                paneId: pane.id,
                collapsed: false,
              },
            ],
            weights: [0.4, 0.6],
          }),
          updatedAt: now,
        })
        .where(eq(worktreeSurfaces.id, surfaceId))
        .run();
      return pane.id;
    });
  });
}

function insertPtySession(input: {
  readonly paneId: number;
  readonly worktreeId: number;
  readonly logPath: string | null;
  readonly status: 'starting' | 'running' | 'exited' | 'failed' | 'killed';
}) {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    return yield* database.use('test_insert_pty_session', (db) => {
      const now = new Date().toISOString();
      const row = db
        .insert(ptySessions)
        .values({
          paneId: input.paneId,
          worktreeId: input.worktreeId,
          backend: 'node_pty',
          backendRefJson: JSON.stringify({
            schemaVersion: 1,
            backend: 'node_pty',
            ptySessionId: 0,
            pid: null,
          }),
          purpose: 'terminal',
          harness: null,
          command: 'bash',
          cwd: '/repo/isagi',
          status: input.status,
          statusReason: null,
          exitCode: input.status === 'exited' ? 0 : null,
          signal: null,
          logMode: input.logPath ? 'backend_file' : 'none',
          logPath: input.logPath,
          createdAt: now,
          updatedAt: now,
          exitedAt:
            input.status === 'exited' || input.status === 'failed' || input.status === 'killed'
              ? now
              : null,
          lastSeenAt: null,
        })
        .returning({ id: ptySessions.id })
        .get();
      db.update(ptySessions)
        .set({
          backendRefJson: JSON.stringify({
            schemaVersion: 1,
            backend: 'node_pty',
            ptySessionId: row.id,
            pid: null,
          }),
        })
        .where(eq(ptySessions.id, row.id))
        .run();
      outputPaneIdBySession.set(row.id, input.paneId);
      return row.id;
    });
  });
}

function testLayer(
  dataRoot: string,
  options: {
    readonly cleanupWarnings?: (ptySessionId: number) => readonly SurfaceDeleteWarning[];
  } = {},
) {
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
  const ptyService = Layer.succeed(PtyService, fakePtyService(options));
  const surfaceRepository = SurfaceRepositoryLive.pipe(
    Layer.provide(database),
    Layer.provide(dataDirectoryLayer),
  );
  const surfaceService = SurfaceServiceLive.pipe(
    Layer.provide(surfaceRepository),
    Layer.provide(ptyService),
  );
  return Layer.mergeAll(database, workspaceRepository, surfaceRepository, surfaceService);
}

function fakePtyService(options: {
  readonly cleanupWarnings?: (ptySessionId: number) => readonly SurfaceDeleteWarning[];
}): PtyServiceShape {
  return {
    launch: () => Effect.die('launch is not used by surface service tests'),
    getAttachmentPlan: () => Effect.die('getAttachmentPlan is not used by surface service tests'),
    attach: () => Effect.die('attach is not used by surface service tests'),
    replay: () => Effect.die('replay is not used by surface service tests'),
    write: () => Effect.die('write is not used by surface service tests'),
    resize: () => Effect.die('resize is not used by surface service tests'),
    kill: () => Effect.die('kill is not used by surface service tests'),
    cleanupSessionForDelete: (input) =>
      Effect.succeed([...(options.cleanupWarnings?.(input.ptySessionId) ?? [])]),
  };
}
