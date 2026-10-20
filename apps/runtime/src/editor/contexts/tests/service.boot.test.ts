import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { Effect } from 'effect';

import type { InternalEvent } from '../../../platform/events/index.js';
import { RuntimeDatabase } from '../../../platform/persistence/index.js';
import { ptyProcesses } from '../../../pty-processes/tables.js';
import {
  editorContextChangedIds,
  editorServiceLayer,
  insertPtyProcess,
  insertWorktree,
  neverSettlingProbe,
} from '../../testing.js';
import { EditorContextRepository } from '../repository.js';
import { EditorContextService } from '../service.js';

test('layer construction converges interrupted attempts and publishes one event each', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-editor-boot-'));
  const events: InternalEvent[] = [];
  try {
    // Two runtimes over one database. The first leaves attempts in flight the way
    // a crash mid-launch would; the second is the one whose *construction* has to
    // resolve them, because nothing else ever will.
    const seeded = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* EditorContextRepository;
        const first = yield* insertWorktree('/repo/isagi');
        const second = yield* insertWorktree('/repo/other');
        const a = yield* repository.create({ worktreeId: first });
        const b = yield* repository.create({ worktreeId: second });
        yield* repository.markAttemptInProgress(a.id);
        return { interrupted: a.id, untouched: b.id };
      }).pipe(
        Effect.provide(
          editorServiceLayer({
            dataRoot,
            events,
            options: { probe: neverSettlingProbe },
          }),
        ),
        Effect.scoped,
      ),
    );

    const booted: InternalEvent[] = [];
    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        // Resolving the service is what forces layer construction, so everything
        // asserted below happened during acquisition rather than afterwards.
        yield* EditorContextService;
        const repository = yield* EditorContextRepository;
        return {
          interrupted: yield* repository.find(seeded.interrupted),
          untouched: yield* repository.find(seeded.untouched),
        };
      }).pipe(
        Effect.provide(
          editorServiceLayer({
            dataRoot,
            events: booted,
            options: { probe: neverSettlingProbe },
          }),
        ),
        Effect.scoped,
      ),
    );

    assert.deepEqual(rows.interrupted?.attempt, {
      state: 'failed',
      reason: 'launch_interrupted',
      detail: null,
    });
    assert.equal(rows.interrupted?.activePtyProcessId, null);
    // An untouched context is not swept up in the convergence.
    assert.deepEqual(rows.untouched?.attempt, { state: 'none' });
    // Exactly one publication, for the one row that changed. The production bus
    // may have no subscriber this early; the durable row is the authoritative
    // result and the event is what a client that connects later will act on.
    assert.deepEqual(editorContextChangedIds(booted), [seeded.interrupted]);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('layer construction releases incarnations the runtime ended and keeps every other ending', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-editor-boot-'));
  try {
    // The first runtime leaves three owned incarnations: one still `running`
    // (a crash, which the next PTY startup records as `runtime_ephemeral_lost`),
    // one a graceful shutdown already killed, and one that exited on its own.
    const seeded = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* EditorContextRepository;
        const database = yield* RuntimeDatabase;
        const own = Effect.fnUntraced(function* (path: string, status: 'running' | 'exited') {
          const worktreeId = yield* insertWorktree(path);
          const context = yield* repository.create({ worktreeId });
          const ptyProcessId = yield* insertPtyProcess(status);
          yield* repository.markAttemptInProgress(context.id);
          yield* repository.installIncarnation({
            editorContextId: context.id,
            handoff: {
              ptyProcessId,
              endpointHost: '127.0.0.1',
              endpointPort: 40_000,
              sessionSocketPath: `/tmp/editor-${context.id}.sock`,
            },
          });
          return { contextId: context.id, ptyProcessId };
        });
        const crashed = yield* own('/repo/crashed', 'running');
        const shutDown = yield* own('/repo/shut-down', 'running');
        const exited = yield* own('/repo/exited', 'exited');
        yield* database.use('test_mark_runtime_shutdown', (db) => {
          db.update(ptyProcesses)
            .set({ status: 'killed', statusReason: 'runtime_shutdown' })
            .where(eq(ptyProcesses.id, shutDown.ptyProcessId))
            .run();
        });
        return { crashed, shutDown, exited };
      }).pipe(
        Effect.provide(
          editorServiceLayer({
            dataRoot,
            events: [],
            options: { probe: neverSettlingProbe },
          }),
        ),
        Effect.scoped,
      ),
    );

    const booted: InternalEvent[] = [];
    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        yield* EditorContextService;
        const repository = yield* EditorContextRepository;
        return {
          crashed: yield* repository.find(seeded.crashed.contextId),
          shutDown: yield* repository.find(seeded.shutDown.contextId),
          exited: yield* repository.find(seeded.exited.contextId),
        };
      }).pipe(
        Effect.provide(
          editorServiceLayer({
            dataRoot,
            events: booted,
            options: { probe: neverSettlingProbe },
          }),
        ),
        Effect.scoped,
      ),
    );

    // Both runtime endings return to idle, so the pane's `reuse` relaunches.
    for (const row of [rows.crashed, rows.shutDown]) {
      assert.equal(row?.activePtyProcessId, null);
      assert.equal(row?.endpointPort, null);
      assert.deepEqual(row?.attempt, { state: 'none' });
    }
    // An exit is the editor's own outcome and stays visible.
    assert.equal(rows.exited?.activePtyProcessId, seeded.exited.ptyProcessId);
    assert.deepEqual(
      editorContextChangedIds(booted).sort(),
      [seeded.crashed.contextId, seeded.shutDown.contextId].sort(),
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
