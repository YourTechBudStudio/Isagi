import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Either } from 'effect';

import { PtyServiceError } from '../../pty-processes/index.js';
import { InternalRuntimeEventBus } from '../../runtime-events/index.js';
import { SurfaceService } from '../index.js';
import {
  addPaneToSurface,
  insertPtyProcess,
  insertWorktree,
  replaceSurfaceLayoutWithSingleDeletedPane,
  testLayer,
} from './test-support.js';

test('delete pane updates layout and keeps the remaining pane', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-delete-pane-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const first = yield* surfaces.createSinglePaneSurface({
          worktreeId,

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

test('delete last pane deletes the surface and leaves referenced logs for PTY GC', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-delete-last-pane-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const surface = yield* surfaces.createSinglePaneSurface({
          worktreeId,

          titleBase: 'Terminal',
        });
        mkdirSync(join(dataRoot, 'sessions'), { recursive: true });
        const logPath = join(dataRoot, 'sessions', 'delete-last-pane.ptylog');
        writeFileSync(logPath, 'session log', 'utf8');
        yield* insertPtyProcess({
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
        return { deleted, detail, logPath, surface };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(output.deleted, {
      deletedSurfaceId: output.surface.surfaceId,
      deletedPaneIds: [output.surface.paneId],
    });
    assert.equal(existsSync(output.logPath), true);
    assert.equal(Either.isLeft(output.detail), true);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('delete surface leaves log cleanup failures to PTY GC', async () => {
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

          titleBase: 'Terminal',
        });
        mkdirSync(join(dataRoot, 'sessions'), { recursive: true });
        const logPath = join(dataRoot, 'sessions', 'log-path-is-directory.ptylog');
        mkdirSync(logPath);
        yield* insertPtyProcess({
          paneId: surface.paneId,
          worktreeId,
          logPath,
          status: 'exited',
        });

        const deleted = yield* surfaces.deleteSurface(surface.surfaceId);
        const detail = yield* surfaces.getSurfaceDetail(surface.surfaceId).pipe(Effect.either);
        return { deleted, detail, logPath, surface };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(output.deleted, {
      deletedSurfaceId: output.surface.surfaceId,
      deletedPaneIds: [output.surface.paneId],
    });
    assert.equal(existsSync(output.logPath), true);
    assert.equal(Either.isLeft(output.detail), true);
    assert.equal(warnings.length, 0);
  } finally {
    console.warn = originalConsoleWarn;
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('delete surface best-effort terminates live PTYs', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-delete-warning-'));
  try {
    const terminations: number[] = [];
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const surface = yield* surfaces.createSinglePaneSurface({
          worktreeId,

          titleBase: 'Terminal',
        });
        yield* insertPtyProcess({
          paneId: surface.paneId,
          worktreeId,
          logPath: null,
          status: 'running',
        });

        const deleted = yield* surfaces.deleteSurface(surface.surfaceId);
        const detail = yield* surfaces.getSurfaceDetail(surface.surfaceId).pipe(Effect.either);
        return { deleted, detail, surface };
      }).pipe(
        Effect.provide(
          testLayer(dataRoot, {
            ptyService: {
              terminate: (input) =>
                Effect.sync(() => {
                  terminations.push(input.ptyProcessId);
                }),
            },
          }),
        ),
      ),
    );

    assert.equal(output.deleted.deletedSurfaceId, output.surface.surfaceId);
    assert.deepEqual(output.deleted.deletedPaneIds, [output.surface.paneId]);
    assert.equal(Either.isLeft(output.detail), true);
    assert.equal(terminations.length, 1);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('delete surface still succeeds when live PTY termination fails', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-delete-termination-failed-'));
  const warnings: unknown[] = [];
  const originalConsoleWarn = console.warn;
  console.warn = (...message: unknown[]) => {
    warnings.push(message);
  };

  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const surface = yield* surfaces.createSinglePaneSurface({
          worktreeId,

          titleBase: 'Terminal',
        });
        yield* insertPtyProcess({
          paneId: surface.paneId,
          worktreeId,
          logPath: null,
          status: 'running',
        });

        const deleted = yield* surfaces.deleteSurface(surface.surfaceId);
        const detail = yield* surfaces.getSurfaceDetail(surface.surfaceId).pipe(Effect.either);
        return { deleted, detail, surface };
      }).pipe(
        Effect.provide(
          testLayer(dataRoot, {
            ptyService: {
              terminate: () =>
                Effect.fail(
                  new PtyServiceError({
                    code: 'backend_unavailable',
                    message: 'test termination failed',
                  }),
                ),
            },
          }),
        ),
      ),
    );

    assert.equal(output.deleted.deletedSurfaceId, output.surface.surfaceId);
    assert.deepEqual(output.deleted.deletedPaneIds, [output.surface.paneId]);
    assert.equal(Either.isLeft(output.detail), true);
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = originalConsoleWarn;
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('delete pane publishes a shared surface changed event', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-delete-pane-event-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const first = yield* surfaces.createSinglePaneSurface({
          worktreeId,

          titleBase: 'Terminal',
        });
        yield* addPaneToSurface(first.surfaceId);
        const eventBus = yield* InternalRuntimeEventBus;
        const subscription = yield* eventBus.subscribe({ types: ['surface_changed'] });

        yield* surfaces.deleteSurfacePane({
          surfaceId: first.surfaceId,
          paneId: first.paneId,
        });
        const event = yield* subscription.take;
        yield* subscription.unsubscribe;
        return { event, first, worktreeId };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(output.event, {
      type: 'surface_changed',
      payload: {
        worktreeId: output.worktreeId,
        surfaceId: output.first.surfaceId,
        change: 'pane_deleted',
        deletedPaneIds: [output.first.paneId],
      },
    });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('delete pane deletes every pane when invalid layout escalates to surface delete', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-delete-pane-invalid-layout-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const surface = yield* surfaces.createSinglePaneSurface({
          worktreeId,

          titleBase: 'Terminal',
        });
        const secondPaneId = yield* addPaneToSurface(surface.surfaceId);
        yield* insertPtyProcess({
          paneId: surface.paneId,
          worktreeId,
          logPath: null,
          status: 'running',
        });
        yield* insertPtyProcess({
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
        return { deleted, detail, surface, secondPaneId };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(output.deleted, {
      deletedSurfaceId: output.surface.surfaceId,
      deletedPaneIds: [output.surface.paneId, output.secondPaneId],
    });
    assert.equal(Either.isLeft(output.detail), true);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
