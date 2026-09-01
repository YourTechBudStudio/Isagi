import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { Cause, Effect, Exit, Layer } from 'effect';

import { EditorContextRepository } from '../../editor-contexts/index.js';
import { RuntimeDatabase } from '../../persistence/index.js';
import {
  surfacePanes,
  worktreeEnvironmentStates,
  worktreeSurfaces,
} from '../../persistence/schema.js';
import { SurfaceRepository, SurfaceRepositoryInitialSessionRejected } from '../index.js';
import { insertWorktree, testLayer } from './test-support.js';

type TestServices = Layer.Layer.Success<ReturnType<typeof testLayer>>;

function inDatabase<A, E>(effect: Effect.Effect<A, E, TestServices>) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-editor-placement-'));
  return Effect.runPromise(effect.pipe(Effect.provide(testLayer(dataRoot)))).finally(() =>
    rmSync(dataRoot, { recursive: true, force: true }),
  );
}

function exitInDatabase<A, E>(effect: Effect.Effect<A, E, TestServices>) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-editor-placement-'));
  return Effect.runPromiseExit(effect.pipe(Effect.provide(testLayer(dataRoot)))).finally(() =>
    rmSync(dataRoot, { recursive: true, force: true }),
  );
}

/** Every row a surface creation would write, so "no residue" can be literal. */
function countSurfaceRows() {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    return yield* database.use('test_count_surface_rows', (db) => ({
      surfaces: db.select().from(worktreeSurfaces).all().length,
      panes: db.select().from(surfacePanes).all().length,
      focus: db.select().from(worktreeEnvironmentStates).all().length,
    }));
  });
}

function rejectionReason<A, E>(exit: Exit.Exit<A, E>) {
  assert.equal(Exit.isFailure(exit), true);
  if (!Exit.isFailure(exit)) return null;
  // A precondition breach is an integrity defect, never a user-facing error:
  // the caller holds the worktree lock and has already checked placement.
  assert.equal(Cause.failureOption(exit.cause)._tag, 'None');
  const defect = Cause.dieOption(exit.cause);
  assert.equal(defect._tag, 'Some');
  if (defect._tag !== 'Some') return null;
  assert.ok(defect.value instanceof SurfaceRepositoryInitialSessionRejected);
  return defect.value.reason;
}

test('an editor context is bound to its pane inside the creating transaction', async () => {
  const { output, pane, focus, joined } = await inDatabase(
    Effect.gen(function* () {
      const surfaces = yield* SurfaceRepository;
      const editors = yield* EditorContextRepository;
      const worktreeId = yield* insertWorktree('/repo/isagi');
      const context = yield* editors.create({ worktreeId });
      const created = yield* surfaces.createSinglePaneSurface({
        worktreeId,
        titleBase: 'Editor',
        initialSession: { kind: 'editor_context', sessionId: context.id },
      });
      const database = yield* RuntimeDatabase;
      return {
        output: created,
        pane: yield* database.use('test_read_pane', (db) =>
          db.select().from(surfacePanes).where(eq(surfacePanes.id, created.paneId)).get(),
        ),
        focus: yield* surfaces.findEnvironmentFocus(worktreeId),
        joined: yield* surfaces.listEditorContextsForPanes([created.paneId]),
      };
    }),
  );

  // Surface, pane, binding, and focus commit together: there is no observable
  // moment at which the pane exists without its editor context.
  assert.equal(pane?.sessionKind, 'editor_context');
  assert.equal(pane?.sessionId, joined[0]?.id);
  assert.equal(focus?.activePaneId, output.paneId);
  assert.equal(focus?.activeSurfaceId, output.surfaceId);
  assert.equal(joined.length, 1);
  assert.deepEqual(joined[0]?.attempt, { state: 'none' });
});

test('placing a context that does not exist is a defect and writes nothing', async () => {
  const exit = await exitInDatabase(
    Effect.gen(function* () {
      const surfaces = yield* SurfaceRepository;
      const worktreeId = yield* insertWorktree('/repo/isagi');
      const before = yield* countSurfaceRows();
      const result = yield* surfaces
        .createSinglePaneSurface({
          worktreeId,
          titleBase: 'Editor',
          initialSession: { kind: 'editor_context', sessionId: 9_999 },
        })
        .pipe(Effect.exit);
      return { result, before, after: yield* countSurfaceRows() };
    }).pipe(
      Effect.flatMap(({ result, before, after }) => {
        assert.deepEqual(after, before);
        return result;
      }),
    ),
  );

  assert.equal(rejectionReason(exit), 'missing');
});

test("placing another worktree's context is refused before anything is written", async () => {
  const exit = await exitInDatabase(
    Effect.gen(function* () {
      const surfaces = yield* SurfaceRepository;
      const editors = yield* EditorContextRepository;
      const ownerWorktreeId = yield* insertWorktree('/repo/one');
      const otherWorktreeId = yield* insertWorktree('/repo/two');
      const context = yield* editors.create({ worktreeId: ownerWorktreeId });
      const before = yield* countSurfaceRows();
      // Binding this would let a surface in one worktree project and later
      // operate on a different worktree's durable editor.
      const result = yield* surfaces
        .createSinglePaneSurface({
          worktreeId: otherWorktreeId,
          titleBase: 'Editor',
          initialSession: { kind: 'editor_context', sessionId: context.id },
        })
        .pipe(Effect.exit);
      return { result, before, after: yield* countSurfaceRows() };
    }).pipe(
      Effect.flatMap(({ result, before, after }) => {
        assert.deepEqual(after, before);
        return result;
      }),
    ),
  );

  assert.equal(rejectionReason(exit), 'foreign_worktree');
});

test('placing an already-placed context is refused and leaves the first placement alone', async () => {
  const exit = await exitInDatabase(
    Effect.gen(function* () {
      const surfaces = yield* SurfaceRepository;
      const editors = yield* EditorContextRepository;
      const worktreeId = yield* insertWorktree('/repo/isagi');
      const context = yield* editors.create({ worktreeId });
      yield* surfaces.createSinglePaneSurface({
        worktreeId,
        titleBase: 'Editor',
        initialSession: { kind: 'editor_context', sessionId: context.id },
      });
      const before = yield* countSurfaceRows();
      const result = yield* surfaces
        .createSinglePaneSurface({
          worktreeId,
          titleBase: 'Editor',
          initialSession: { kind: 'editor_context', sessionId: context.id },
        })
        .pipe(Effect.exit);
      return { result, before, after: yield* countSurfaceRows() };
    }).pipe(
      Effect.flatMap(({ result, before, after }) => {
        assert.deepEqual(after, before);
        return result;
      }),
    ),
  );

  assert.equal(rejectionReason(exit), 'already_placed');
});

test('a missing worktree fails the whole transaction, binding or not', async () => {
  const { rows } = await inDatabase(
    Effect.gen(function* () {
      const surfaces = yield* SurfaceRepository;
      yield* surfaces
        .createSinglePaneSurface({ worktreeId: 9_999, titleBase: 'Editor' })
        .pipe(Effect.exit);
      return { rows: yield* countSurfaceRows() };
    }),
  );

  assert.deepEqual(rows, { surfaces: 0, panes: 0, focus: 0 });
});

test('agent and terminal creation still writes a sessionless pane', async () => {
  const pane = await inDatabase(
    Effect.gen(function* () {
      const surfaces = yield* SurfaceRepository;
      const worktreeId = yield* insertWorktree('/repo/isagi');
      // The unchanged two-step ordering: `initialSession` is the editor path's
      // seam only, and this phase deliberately does not repair the other kinds.
      const output = yield* surfaces.createSinglePaneSurface({ worktreeId, titleBase: 'Pi' });
      const database = yield* RuntimeDatabase;
      return yield* database.use('test_read_pane', (db) =>
        db.select().from(surfacePanes).where(eq(surfacePanes.id, output.paneId)).get(),
      );
    }),
  );

  assert.equal(pane?.sessionKind, null);
  assert.equal(pane?.sessionId, null);
});

test('an editor pane is findable by its session and excluded from the PTY-backed inventory', async () => {
  const { placement, bindings, emptyJoin } = await inDatabase(
    Effect.gen(function* () {
      const surfaces = yield* SurfaceRepository;
      const editors = yield* EditorContextRepository;
      const worktreeId = yield* insertWorktree('/repo/isagi');
      const context = yield* editors.create({ worktreeId });
      const output = yield* surfaces.createSinglePaneSurface({
        worktreeId,
        titleBase: 'Editor',
        initialSession: { kind: 'editor_context', sessionId: context.id },
      });
      return {
        placement: yield* surfaces.findPaneForSession({
          sessionKind: 'editor_context',
          sessionId: context.id,
        }),
        // Structural exclusion: no boot-eager relaunch and no session GC for an
        // editor context, even though the pane-kind enum now admits one.
        bindings: yield* surfaces.listPaneSessionBindings,
        emptyJoin: yield* surfaces.listEditorContextsForPanes([]),
        output,
      };
    }),
  );

  assert.equal(placement?.paneId !== undefined, true);
  assert.deepEqual(bindings, []);
  assert.deepEqual(emptyJoin, []);
});
