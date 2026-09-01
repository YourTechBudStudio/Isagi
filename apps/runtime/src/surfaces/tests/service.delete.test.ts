import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Either } from 'effect';

import { EditorContextRepository } from '../../editor-contexts/index.js';
import { insertPtyProcess as insertEditorPtyProcess } from '../../editor-contexts/test-support.js';
import { DatabaseError } from '../../persistence/index.js';
import { PtyServiceError } from '../../pty-processes/index.js';
import { InternalRuntimeEventBus } from '../../runtime-events/index.js';
import { SurfaceRepository, SurfaceService } from '../index.js';
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

test('delete pane no-ops when the pane is missing', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-delete-pane-missing-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const surface = yield* surfaces.createSinglePaneSurface({
          worktreeId,
          titleBase: 'Terminal',
        });

        return yield* surfaces.deleteSurfacePane({
          surfaceId: surface.surfaceId,
          paneId: surface.paneId + 999,
        });
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(output, { deletedSurfaceId: null, deletedPaneIds: [] });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('delete pane no-ops when the pane deletion already removed the surface', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-delete-pane-repeat-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const surface = yield* surfaces.createSinglePaneSurface({
          worktreeId,
          titleBase: 'Terminal',
        });
        const first = yield* surfaces.deleteSurfacePane({
          surfaceId: surface.surfaceId,
          paneId: surface.paneId,
        });
        const second = yield* surfaces.deleteSurfacePane({
          surfaceId: surface.surfaceId,
          paneId: surface.paneId,
        });
        return { first, second, surface };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(output.first, {
      deletedSurfaceId: output.surface.surfaceId,
      deletedPaneIds: [output.surface.paneId],
    });
    assert.deepEqual(output.second, { deletedSurfaceId: null, deletedPaneIds: [] });
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
                  return 'terminated_live' as const;
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

// ---------------------------------------------------------------------------
// Editor panes
//
// Deletion of an editor's surface is the one path that must hold the
// per-worktree editor lock across capture, placement removal, the placement
// re-check, and the release decision. These assert what lands on the durable
// row, because the response is deliberately identical in every branch.
// ---------------------------------------------------------------------------

/** Places an editor and gives it a live incarnation through the sanctioned
 *  repository transitions, so the seeded row is one the runtime could really
 *  have produced. No process is spawned. */
function openEditorWithIncarnation(worktreeId: number) {
  return Effect.gen(function* () {
    const surfaces = yield* SurfaceService;
    const opened = yield* surfaces.openEditor({ worktreeId });
    const repository = yield* EditorContextRepository;
    const ptyProcessId = yield* insertEditorPtyProcess();
    yield* repository.markAttemptInProgress(opened.editorContextId);
    yield* repository.installIncarnation({
      editorContextId: opened.editorContextId,
      handoff: {
        ptyProcessId,
        endpointHost: '127.0.0.1',
        endpointPort: 41_234,
        sessionSocketPath: '/tmp/isagi-editor-test.sock',
      },
    });
    return { opened, ptyProcessId };
  });
}

test('deleting an editor surface clears ownership when termination is affirmative', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-delete-editor-'));
  const terminated: number[] = [];
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const { opened, ptyProcessId } = yield* openEditorWithIncarnation(worktreeId);
        const surfaces = yield* SurfaceService;
        const deleted = yield* surfaces.deleteSurface(opened.surfaceId);
        const repository = yield* EditorContextRepository;
        return {
          opened,
          ptyProcessId,
          deleted,
          row: yield* repository.find(opened.editorContextId),
        };
      }).pipe(
        Effect.provide(
          testLayer(dataRoot, {
            ptyService: {
              terminate: (input) =>
                Effect.sync(() => {
                  terminated.push(input.ptyProcessId);
                  return 'terminated_live' as const;
                }),
            },
          }),
        ),
      ),
    );

    assert.equal(output.deleted.deletedSurfaceId, output.opened.surfaceId);
    // The editor was terminated by the editor domain, not by the best-effort
    // helper the sibling kinds use.
    assert.deepEqual(terminated, [output.ptyProcessId]);
    // The durable context survives the deletion unplaced; only its incarnation
    // is released.
    assert.ok(output.row);
    assert.equal(output.row?.activePtyProcessId, null);
    assert.equal(output.row?.endpointHost, null);
    assert.deepEqual(output.row?.attempt, { state: 'none' });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('a refused editor termination still deletes the surface and retains ownership honestly', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-delete-editor-refused-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const { opened, ptyProcessId } = yield* openEditorWithIncarnation(worktreeId);
        const surfaces = yield* SurfaceService;
        const deleted = yield* surfaces.deleteSurface(opened.surfaceId);
        const repository = yield* EditorContextRepository;
        return {
          opened,
          ptyProcessId,
          deleted,
          row: yield* repository.find(opened.editorContextId),
        };
      }).pipe(
        Effect.provide(
          testLayer(dataRoot, {
            ptyService: {
              terminate: () =>
                Effect.fail(
                  new PtyServiceError({
                    code: 'backend_unavailable',
                    message: 'the process refused to stop',
                  }),
                ),
            },
          }),
        ),
      ),
    );

    // Placement removal never fails on a cleanup problem.
    assert.equal(output.deleted.deletedSurfaceId, output.opened.surfaceId);
    // Ownership is retained rather than dropped on an unconfirmed stop, and the
    // reason is the one the row mapper permits beside a live pointer.
    assert.equal(output.row?.activePtyProcessId, output.ptyProcessId);
    assert.equal(output.row?.endpointHost, '127.0.0.1');
    assert.equal(output.row?.attempt.state, 'failed');
    assert.equal(
      output.row?.attempt.state === 'failed' ? output.row.attempt.reason : null,
      'previous_incarnation_not_stopped',
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('deleting a terminal pane beside an editor pane keeps the unlocked fast path', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-delete-editor-sibling-'));
  const terminated: number[] = [];
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const { opened, ptyProcessId } = yield* openEditorWithIncarnation(worktreeId);
        // A second pane on the editor's own surface, holding a terminal.
        const terminalPaneId = yield* addPaneToSurface(opened.surfaceId);
        yield* insertPtyProcess({
          paneId: terminalPaneId,
          worktreeId,
          logPath: null,
          status: 'running',
        });
        const surfaces = yield* SurfaceService;
        const deleted = yield* surfaces.deleteSurfacePane({
          surfaceId: opened.surfaceId,
          paneId: terminalPaneId,
        });
        const repository = yield* EditorContextRepository;
        return {
          opened,
          ptyProcessId,
          deleted,
          row: yield* repository.find(opened.editorContextId),
        };
      }).pipe(
        Effect.provide(
          testLayer(dataRoot, {
            ptyService: {
              terminate: (input) =>
                Effect.sync(() => {
                  terminated.push(input.ptyProcessId);
                  return 'terminated_live' as const;
                }),
            },
          }),
        ),
      ),
    );

    // The plan removes only the terminal pane, so the editor is untouched: its
    // incarnation is neither released nor terminated.
    assert.deepEqual(output.deleted.deletedPaneIds, [output.deleted.deletedPaneIds[0]]);
    assert.equal(output.deleted.deletedSurfaceId, null);
    assert.equal(terminated.includes(output.ptyProcessId), false);
    assert.equal(output.row?.activePtyProcessId, output.ptyProcessId);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('an editor still placed when the lock is acquired is never terminated', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-delete-editor-replaced-'));
  const terminated: number[] = [];
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const { opened, ptyProcessId } = yield* openEditorWithIncarnation(worktreeId);
        const surfaces = yield* SurfaceService;
        // Delete and re-open, interleaved: whichever takes the lock first wins
        // completely, and the re-placed editor must keep its process either way.
        const [, reopened] = yield* Effect.all(
          [surfaces.deleteSurface(opened.surfaceId), surfaces.openEditor({ worktreeId })],
          { concurrency: 'unbounded' },
        );
        const repository = yield* EditorContextRepository;
        return {
          opened,
          reopened,
          ptyProcessId,
          row: yield* repository.find(opened.editorContextId),
          placement: yield* (yield* SurfaceRepository).findPaneForSession({
            sessionKind: 'editor_context',
            sessionId: opened.editorContextId,
          }),
        };
      }).pipe(
        Effect.provide(
          testLayer(dataRoot, {
            ptyService: {
              terminate: (input) =>
                Effect.sync(() => {
                  terminated.push(input.ptyProcessId);
                  return 'terminated_live' as const;
                }),
            },
            // Give the two operations a real interleaving point; SQLite is
            // synchronous, so without one they would simply run in sequence and
            // the race would never be exercised.
            decorateEditorService: (inner) => ({
              ...inner,
              findForWorktree: (id) =>
                Effect.tap(inner.findForWorktree(id), () => Effect.yieldNow()),
            }),
          }),
        ),
      ),
    );

    // Exactly one durable context throughout, whichever side took the lock
    // first.
    assert.equal(output.reopened.editorContextId, output.opened.editorContextId);
    assert.ok(output.row);
    if (terminated.includes(output.ptyProcessId)) {
      // The deletion won: it released the incarnation, so the re-placed context
      // is idle and the pane relaunches on demand. What must never survive is a
      // row still pointing at the process the deletion killed.
      assert.equal(output.row?.activePtyProcessId, null);
    } else {
      // The open won: the placement re-check inside the lock found the context
      // re-placed, so the deletion left the live incarnation alone.
      assert.equal(output.row?.activePtyProcessId, output.ptyProcessId);
      assert.ok(output.placement);
    }
    // Either way the editor ends up placed, because the open either preceded the
    // release or re-placed the context after it.
    assert.ok(output.placement);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('a release failure after the deletion commits still publishes, then fails honestly', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-delete-editor-release-failed-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const { opened } = yield* openEditorWithIncarnation(worktreeId);
        const eventBus = yield* InternalRuntimeEventBus;
        const subscription = yield* eventBus.subscribe({ types: ['surface_changed'] });
        const surfaces = yield* SurfaceService;
        const result = yield* Effect.either(surfaces.deleteSurface(opened.surfaceId));
        const published = yield* subscription.take;
        yield* subscription.unsubscribe;
        const surfaceStillThere = yield* (yield* SurfaceRepository).findSurface(opened.surfaceId);
        return { opened, result, published, surfaceStillThere };
      }).pipe(
        Effect.provide(
          testLayer(dataRoot, {
            decorateEditorService: (inner) => ({
              ...inner,
              releaseIncarnation: () =>
                Effect.fail(
                  new DatabaseError({ operation: 'clear_editor_incarnation', cause: 'disk full' }),
                ),
            }),
          }),
        ),
      ),
    );

    // The deletion committed, so the client is told — otherwise it would keep
    // rendering a surface the database has already removed.
    assert.equal(output.surfaceStillThere, null);
    assert.equal(output.published.type, 'surface_changed');
    assert.equal(
      output.published.type === 'surface_changed' ? output.published.payload.change : null,
      'deleted',
    );
    // And the failure is re-raised rather than absorbed: durable cleanup did not
    // settle as intended, and reporting success would hide that.
    assert.ok(Either.isLeft(output.result));
    assert.equal(output.result.left._tag, 'DatabaseError');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
