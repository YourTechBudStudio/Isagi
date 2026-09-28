import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { Deferred, Effect, Either, Fiber } from 'effect';

import { RuntimeDatabase } from '../../persistence/index.js';
import { ptyProcesses, surfacePanes, terminalSessions } from '../../persistence/schema.js';
import { SurfaceError, SurfaceRepository, SurfaceService } from '../index.js';
import { insertPtyProcess, insertWorktree, testLayer } from './test-support.js';

function withTerminals(dataRoot: string) {
  let nextTerminalSessionId = 300;
  return testLayer(dataRoot, {
    terminalService: {
      startFresh: () =>
        Effect.sync(() => {
          nextTerminalSessionId += 1;
          return { terminalSessionId: nextTerminalSessionId };
        }),
    },
  });
}

test('an empty surface has no panes and no layout, and is focused with no active pane', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-empty-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const created = yield* surfaces.createEmptySurface({ worktreeId, titleBase: ' Review ' });
        return { created, detail: yield* surfaces.getSurfaceDetail(created.surfaceId) };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(output.created.title, 'Review');
    assert.deepEqual(output.detail.panes, []);
    assert.equal(output.detail.layout, null);
    assert.equal(output.detail.activePaneId, null);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('starting a pane in an empty surface makes it the root leaf, binds its session, and focuses it', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-start-pane-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const created = yield* surfaces.createEmptySurface({ worktreeId, titleBase: 'Review' });
        const started = yield* surfaces.startPane({
          surfaceId: created.surfaceId,
          start: { newPane: { kind: 'terminal_session' } },
        });
        const database = yield* RuntimeDatabase;
        const pane = yield* database.use('test_find_started_pane', (db) =>
          db.select().from(surfacePanes).where(eq(surfacePanes.id, started.paneId)).get(),
        );
        return {
          worktreeId,
          created,
          started,
          pane,
          detail: yield* surfaces.getSurfaceDetail(created.surfaceId),
        };
      }).pipe(Effect.provide(withTerminals(dataRoot))),
    );

    assert.deepEqual(output.started, {
      worktreeId: output.worktreeId,
      surfaceId: output.created.surfaceId,
      paneId: output.started.paneId,
      title: 'Terminal',
    });
    assert.equal(output.pane?.sessionKind, 'terminal_session');
    assert.equal(output.pane?.sessionId, 301);
    assert.equal(output.detail.activePaneId, output.started.paneId);
    assert.deepEqual(output.detail.layout, {
      kind: 'leaf',
      nodeId: `pane-${output.started.paneId}`,
      paneId: output.started.paneId,
      collapsed: false,
    });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('starting a pane is refused on a surface that already has panes, and on a missing one', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-start-pane-refused-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const surface = yield* surfaces.createSurface({
          worktreeId,
          initialPane: { kind: 'terminal_session' },
        });
        const start = { newPane: { kind: 'terminal_session' } } as const;
        return {
          surface,
          occupied: yield* Effect.either(
            surfaces.startPane({ surfaceId: surface.surfaceId, start }),
          ),
          missing: yield* Effect.either(surfaces.startPane({ surfaceId: 9_999, start })),
          detail: yield* surfaces.getSurfaceDetail(surface.surfaceId),
        };
      }).pipe(Effect.provide(withTerminals(dataRoot))),
    );

    assert.ok(Either.isLeft(output.occupied));
    assert.ok(output.occupied.left instanceof SurfaceError);
    assert.equal(output.occupied.left.code, 'surface_not_empty');
    assert.ok(Either.isLeft(output.missing));
    assert.ok(output.missing.left instanceof SurfaceError);
    assert.equal(output.missing.left.code, 'surface_not_found');
    assert.equal(output.detail.panes.length, 1);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('a surface emptied by closing its last pane can start a pane again', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-restart-pane-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const surface = yield* surfaces.createSurface({
          worktreeId,
          initialPane: { kind: 'terminal_session' },
        });
        yield* surfaces.deleteSurfacePane({ surfaceId: surface.surfaceId, paneId: surface.paneId });
        const started = yield* surfaces.startPane({
          surfaceId: surface.surfaceId,
          start: { newPane: { kind: 'terminal_session' } },
        });
        return { surface, started, detail: yield* surfaces.getSurfaceDetail(surface.surfaceId) };
      }).pipe(Effect.provide(withTerminals(dataRoot))),
    );

    assert.equal(output.started.surfaceId, output.surface.surfaceId);
    assert.deepEqual(
      output.detail.panes.map((pane) => pane.id),
      [output.started.paneId],
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('opening an unplaced editor into an empty surface fills that surface instead of creating one', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-open-editor-into-empty-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const empty = yield* surfaces.createEmptySurface({ worktreeId, titleBase: 'Scratch' });
        const opened = yield* surfaces.openEditor({ worktreeId, intoSurfaceId: empty.surfaceId });
        // Already placed: a second open into another empty surface answers with the existing
        // placement and leaves that surface empty.
        const other = yield* surfaces.createEmptySurface({ worktreeId, titleBase: 'Other' });
        const reopened = yield* surfaces.openEditor({ worktreeId, intoSurfaceId: other.surfaceId });
        return {
          empty,
          opened,
          reopened,
          detail: yield* surfaces.getSurfaceDetail(empty.surfaceId),
          otherDetail: yield* surfaces.getSurfaceDetail(other.surfaceId),
        };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(output.opened.surfaceId, output.empty.surfaceId);
    assert.equal(output.detail.panes[0]?.session?.kind, 'editor_context');
    assert.deepEqual(output.reopened, output.opened);
    assert.deepEqual(output.otherDetail.panes, []);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('opening an editor into a surface that has panes is refused and leaves it unplaced', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-open-editor-into-occupied-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const surface = yield* surfaces.createSurface({
          worktreeId,
          initialPane: { kind: 'terminal_session' },
        });
        const refused = yield* Effect.either(
          surfaces.openEditor({ worktreeId, intoSurfaceId: surface.surfaceId }),
        );
        return { refused, detail: yield* surfaces.getSurfaceDetail(surface.surfaceId) };
      }).pipe(Effect.provide(withTerminals(dataRoot))),
    );

    assert.ok(Either.isLeft(output.refused));
    assert.ok(output.refused.left instanceof SurfaceError);
    assert.equal(output.refused.left.code, 'surface_not_empty');
    assert.equal(output.detail.panes.length, 1);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('a first pane whose session fails to start is removed, leaving the surface empty', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-start-pane-fails-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const created = yield* surfaces.createEmptySurface({ worktreeId, titleBase: 'Review' });
        const started = yield* Effect.either(
          surfaces.startPane({
            surfaceId: created.surfaceId,
            start: { newPane: { kind: 'terminal_session' } },
          }),
        );
        return { started, detail: yield* surfaces.getSurfaceDetail(created.surfaceId) };
      }).pipe(
        Effect.provide(
          testLayer(dataRoot, {
            terminalService: {
              startFresh: () => Effect.fail(new Error('the shell would not start') as never),
            },
          }),
        ),
      ),
    );

    assert.ok(Either.isLeft(output.started));
    assert.deepEqual(output.detail.panes, []);
    assert.equal(output.detail.layout, null);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('concurrent deletes of both panes leave an empty surface that can start a pane', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-concurrent-delete-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const surface = yield* surfaces.createSurface({
          worktreeId,
          initialPane: { kind: 'terminal_session' },
        });
        const split = yield* surfaces.splitPane({
          worktreeId,
          split: {
            paneId: surface.paneId,
            direction: 'right',
            newPane: { kind: 'terminal_session' },
          },
        });
        yield* Effect.all(
          [
            surfaces.deleteSurfacePane({ surfaceId: surface.surfaceId, paneId: surface.paneId }),
            surfaces.deleteSurfacePane({ surfaceId: surface.surfaceId, paneId: split.paneId }),
          ],
          { concurrency: 'unbounded' },
        );
        const emptied = yield* surfaces.getSurfaceDetail(surface.surfaceId);
        const restarted = yield* surfaces.startPane({
          surfaceId: surface.surfaceId,
          start: { newPane: { kind: 'terminal_session' } },
        });
        return { emptied, restarted };
      }).pipe(Effect.provide(withTerminals(dataRoot))),
    );

    assert.deepEqual(output.emptied.panes, []);
    assert.equal(output.emptied.layout, null);
    assert.ok(output.restarted.paneId > 0);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('the repository plans each pane delete from current rows, so a stale view cannot corrupt the layout', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-delete-current-rows-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const surface = yield* surfaces.createSurface({
          worktreeId,
          initialPane: { kind: 'terminal_session' },
        });
        const split = yield* surfaces.splitPane({
          worktreeId,
          split: {
            paneId: surface.paneId,
            direction: 'right',
            newPane: { kind: 'terminal_session' },
          },
        });
        // Both deletes are issued as if planned from the same two-pane view.
        const repository = yield* SurfaceRepository;
        const first = yield* repository.deleteSurfacePane({
          surfaceId: surface.surfaceId,
          paneId: surface.paneId,
        });
        const second = yield* repository.deleteSurfacePane({
          surfaceId: surface.surfaceId,
          paneId: split.paneId,
        });
        return { first, second, detail: yield* surfaces.getSurfaceDetail(surface.surfaceId) };
      }).pipe(Effect.provide(withTerminals(dataRoot))),
    );

    assert.equal(output.first.deletedPanes.length, 1);
    assert.equal(output.second.deletedPanes.length, 1);
    assert.deepEqual(output.detail.panes, []);
    assert.equal(output.detail.layout, null);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('opening a placed editor ignores a target surface that has since been closed', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-open-editor-stale-target-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const opened = yield* surfaces.openEditor({ worktreeId, intoSurfaceId: null });
        const empty = yield* surfaces.createEmptySurface({ worktreeId, titleBase: 'Scratch' });
        yield* surfaces.deleteSurface(empty.surfaceId);
        const reopened = yield* surfaces.openEditor({ worktreeId, intoSurfaceId: empty.surfaceId });
        return { opened, reopened };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(output.reopened, output.opened);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('closing a surface while its first pane starts up leaves the new session unplaced for orphan GC and starts no process', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-close-during-start-'));
  // Startup is suspended after the durable session exists and before it is
  // bound: the window a close has to land in.
  const created = Effect.runSync(Deferred.make<number>());
  const resume = Effect.runSync(Deferred.make<void>());
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const surface = yield* surfaces.createEmptySurface({ worktreeId, titleBase: 'Review' });
        const starting = yield* Effect.fork(
          surfaces.startPane({
            surfaceId: surface.surfaceId,
            start: { newPane: { kind: 'terminal_session' } },
          }),
        );
        const sessionId = yield* Deferred.await(created);
        const closed = yield* surfaces.deleteSurface(surface.surfaceId);
        yield* Deferred.succeed(resume, undefined);
        const started = yield* Effect.either(Fiber.join(starting));
        const database = yield* RuntimeDatabase;
        const rows = yield* database.use('test_close_during_start_rows', (db) => ({
          sessions: db.select().from(terminalSessions).all(),
          panes: db.select().from(surfacePanes).all(),
          processes: db.select().from(ptyProcesses).all(),
        }));
        return { closed, started, sessionId, rows, surfaceId: surface.surfaceId };
      }).pipe(
        Effect.provide(
          testLayer(dataRoot, {
            decorateTerminalService: (inner) => ({
              ...inner,
              startFresh: (input) =>
                inner
                  .startFresh(input)
                  .pipe(
                    Effect.tap((result) =>
                      Deferred.succeed(created, result.terminalSessionId).pipe(
                        Effect.zipRight(Deferred.await(resume)),
                      ),
                    ),
                  ),
            }),
          }),
        ),
      ),
    );

    assert.equal(output.closed.deletedSurfaceId, output.surfaceId);
    assert.ok(Either.isLeft(output.started));
    assert.ok(output.started.left instanceof SurfaceError);
    assert.equal(output.started.left.code, 'pane_not_found');
    assert.ok(output.sessionId > 0);
    assert.deepEqual(
      output.rows.sessions.map((session) => session.id),
      [output.sessionId],
      'the unbound session is left for orphan GC',
    );
    assert.deepEqual(output.rows.panes, [], 'no pane points at it');
    assert.deepEqual(output.rows.processes, [], 'no process was ever started for it');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('a delete cleans up the sessions bound when it commits, not when it was planned', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-delete-reads-bindings-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const repository = yield* SurfaceRepository;
        const surface = yield* surfaces.createEmptySurface({ worktreeId, titleBase: 'Review' });
        const started = yield* repository.startSurfacePane({
          surfaceId: surface.surfaceId,
          titleBase: 'Terminal',
        });
        assert.equal(started.status, 'started');
        if (started.status !== 'started') throw new Error('unreachable');
        // What a close reads before its transaction: a pane with no session yet.
        const stale = yield* repository.findSurfaceDeleteTarget(surface.surfaceId);
        // Startup binds a live session in between.
        const { ptyProcessId } = yield* insertPtyProcess({
          paneId: started.paneId,
          worktreeId,
          logPath: null,
          status: 'running',
        });
        const deleted = yield* repository.deleteSurface(surface.surfaceId);
        const sessions = yield* repository.listSessionsBoundTo(deleted.deletedPanes);
        return { stale, deleted, sessions, ptyProcessId };
      }).pipe(Effect.provide(withTerminals(dataRoot))),
    );

    assert.equal(output.stale?.panes[0]?.pane.sessionId, null);
    assert.equal(output.deleted.deletedPanes[0]?.sessionKind, 'terminal_session');
    assert.deepEqual(
      output.sessions.terminals.map((session) => session.activePtyProcessId),
      [output.ptyProcessId],
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
