import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Either } from 'effect';

import { RuntimeDatabase } from '../../persistence/index.js';
import {
  editorContexts,
  ptyProcesses,
  surfacePanes,
  worktreeSurfaces,
} from '../../persistence/schema.js';
import { SurfaceService } from '../index.js';
import { insertWorktree, testLayer } from './test-support.js';

/** Durable state, read directly. The three open branches are deliberately
 *  indistinguishable in the response, so every assertion here is about rows. */
function counts() {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    return yield* database.use('test_open_editor_counts', (db) => ({
      contexts: db.select().from(editorContexts).all().length,
      surfaces: db.select().from(worktreeSurfaces).all().length,
      panes: db.select().from(surfacePanes).all(),
      ptyProcesses: db.select().from(ptyProcesses).all().length,
    }));
  });
}

test('opening an editor for a fresh worktree commits context, surface, pane, and binding together', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-open-editor-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const opened = yield* surfaces.openEditor({ worktreeId });
        return {
          worktreeId,
          opened,
          state: yield* counts(),
          focus: yield* surfaces.getSurfaceDetail(opened.surfaceId),
        };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(output.opened.worktreeId, output.worktreeId);
    assert.equal(output.state.contexts, 1);
    assert.equal(output.state.surfaces, 1);
    assert.equal(output.state.panes.length, 1);
    // The binding is written inside the create transaction, so there is no
    // observable point at which a committed editor surface holds a sessionless
    // pane.
    assert.equal(output.state.panes[0]?.sessionKind, 'editor_context');
    assert.equal(output.state.panes[0]?.sessionId, output.opened.editorContextId);
    // Focus is written by the same transaction.
    assert.equal(output.focus.activePaneId, output.opened.paneId);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('open starts no process: the editor runtime is strictly on demand', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-open-editor-no-pty-'));
  try {
    // The shared PTY double dies on `allocateLaunch`, so a launch on this path
    // would be a defect rather than a silently created row.
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        yield* (yield* SurfaceService).openEditor({ worktreeId });
        return yield* counts();
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(state.ptyProcesses, 0);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('a second open converges on the same placement after the surface is renamed and reordered', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-open-editor-idempotent-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const first = yield* surfaces.openEditor({ worktreeId });
        // Identity is the row and placement is resolved by id, so a mutable
        // title and a changed order are invisible to the second open.
        yield* surfaces.renameSurface({ surfaceId: first.surfaceId, title: 'Renamed editor' });
        yield* surfaces.createSinglePaneSurface({ worktreeId, titleBase: 'Terminal' });
        yield* surfaces.moveSurfaceOrder({
          worktreeId,
          surfaceId: first.surfaceId,
          beforeSurfaceId: null,
        });
        const second = yield* surfaces.openEditor({ worktreeId });
        return { first, second, state: yield* counts() };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(output.second, output.first);
    assert.equal(output.state.contexts, 1);
    // One editor surface, plus the terminal surface the test created.
    assert.equal(output.state.surfaces, 2);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('an unplaced context is re-placed onto a new surface without creating a second context', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-open-editor-replace-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const first = yield* surfaces.openEditor({ worktreeId });
        // Deleting the surface removes placement; the durable context survives
        // unplaced, which is a normal repairable state rather than garbage.
        yield* surfaces.deleteSurface(first.surfaceId);
        const afterDelete = yield* counts();
        const second = yield* surfaces.openEditor({ worktreeId });
        return { first, second, afterDelete, state: yield* counts() };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(output.afterDelete.contexts, 1);
    assert.equal(output.afterDelete.surfaces, 0);
    assert.equal(output.second.editorContextId, output.first.editorContextId);
    assert.notEqual(output.second.surfaceId, output.first.surfaceId);
    assert.equal(output.state.contexts, 1);
    assert.equal(output.state.surfaces, 1);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('two concurrent opens produce exactly one context and one surface', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-open-editor-concurrent-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const [first, second] = yield* Effect.all(
          [surfaces.openEditor({ worktreeId }), surfaces.openEditor({ worktreeId })],
          { concurrency: 'unbounded' },
        );
        return { first, second, state: yield* counts() };
      }).pipe(
        Effect.provide(
          testLayer(dataRoot, {
            // Suspend between "is there a context?" and creating one — the exact
            // window the lock closes. Without this the two forked opens never
            // interleave, because every step between them is synchronous SQLite,
            // and the assertion would pass with the lock removed. With it, the
            // pre-lock code loses both the surface and the context to a
            // duplicate; verified by temporarily bypassing `withLock`.
            decorateEditorService: (inner) => ({
              ...inner,
              findForWorktree: (worktreeId) =>
                Effect.tap(inner.findForWorktree(worktreeId), () => Effect.yieldNow()),
            }),
          }),
        ),
      ),
    );

    // Whichever acquired the per-worktree lock first wins completely; the other
    // finds the context and its placement and mutates nothing.
    assert.deepEqual(output.second, output.first);
    assert.equal(output.state.contexts, 1);
    assert.equal(output.state.surfaces, 1);
    assert.equal(output.state.panes.length, 1);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('an unprovisioned runtime refuses before any row is written', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-open-editor-unavailable-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const result = yield* Effect.either(surfaces.openEditor({ worktreeId }));
        return { result, state: yield* counts() };
      }).pipe(Effect.provide(testLayer(dataRoot, { editorProvisioning: 'unavailable' }))),
    );

    assert.ok(Either.isLeft(output.result));
    assert.equal(output.result.left._tag, 'EditorUnavailable');
    assert.equal(output.state.contexts, 0);
    assert.equal(output.state.surfaces, 0);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('an unknown worktree is rejected as worktree_not_found', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-open-editor-missing-worktree-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const result = yield* Effect.either(surfaces.openEditor({ worktreeId: 987_654 }));
        return { result, state: yield* counts() };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.ok(Either.isLeft(output.result));
    assert.equal(output.result.left._tag, 'SurfaceError');
    assert.equal(
      Either.isLeft(output.result) && output.result.left._tag === 'SurfaceError'
        ? output.result.left.code
        : null,
      'worktree_not_found',
    );
    assert.equal(output.state.contexts, 0);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
