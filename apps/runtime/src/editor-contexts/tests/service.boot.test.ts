import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import type { InternalRuntimeEvent } from '../../runtime-events/index.js';
import { EditorContextRepository } from '../editor-contexts.repository.js';
import { EditorContextService } from '../editor-contexts.service.js';
import {
  editorContextChangedIds,
  editorServiceLayer,
  insertWorktree,
  neverSettlingProbe,
} from '../test-support.js';

test('layer construction converges interrupted attempts and publishes one event each', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-editor-boot-'));
  const events: InternalRuntimeEvent[] = [];
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
          editorServiceLayer({ dataRoot, events, options: { probe: neverSettlingProbe } }),
        ),
        Effect.scoped,
      ),
    );

    const booted: InternalRuntimeEvent[] = [];
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
