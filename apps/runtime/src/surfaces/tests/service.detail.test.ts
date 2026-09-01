import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { Effect } from 'effect';

import { EditorContextRepository } from '../../editor-contexts/index.js';
import { insertPtyProcess as insertEditorPtyProcess } from '../../editor-contexts/test-support.js';
import { RuntimeDatabase } from '../../persistence/index.js';
import { editorContexts } from '../../persistence/schema.js';
import { SurfaceService } from '../index.js';
import { insertWorktree, testLayer } from './test-support.js';

test('an editor pane projects the editor context beside its placement', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-detail-editor-'));
  try {
    const detail = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
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
            sessionSocketPath: '/tmp/isagi-editor-detail.sock',
          },
        });
        return { opened, ptyProcessId, detail: yield* surfaces.getSurfaceDetail(opened.surfaceId) };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    const session = detail.detail.panes[0]?.session;
    assert.equal(session?.kind, 'editor_context');
    if (session?.kind !== 'editor_context') return;
    // `paneId` is the whole reason the contract splits the editor's own facts
    // from this pane-bound metadata: only the surfaces layer knows placement.
    assert.equal(session.editorContext.paneId, detail.opened.paneId);
    assert.equal(session.editorContext.id, detail.opened.editorContextId);
    assert.equal(session.editorContext.activePtyProcessId, detail.ptyProcessId);
    // The composed loopback URL is the runtime's, not the client's: the pane
    // frames exactly what the runtime allocated and bound.
    assert.deepEqual(session.editorContext.endpoint, {
      host: '127.0.0.1',
      port: 41_234,
      url: 'http://127.0.0.1:41234',
    });
    // No probe has settled for this incarnation, so readiness is honestly
    // unknown rather than optimistically ready.
    assert.equal(session.editorContext.workbenchReadiness, 'unknown');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('an editor pane whose context row vanished projects a null session, like its siblings', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-detail-editor-missing-'));
  try {
    const detail = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const opened = yield* surfaces.openEditor({ worktreeId });
        const database = yield* RuntimeDatabase;
        // The binding outlives the row only if something deleted it out from
        // under the pane; the projection must not throw when it happens.
        yield* database.use('test_delete_editor_context', (db) => {
          db.delete(editorContexts).where(eq(editorContexts.id, opened.editorContextId)).run();
        });
        return yield* surfaces.getSurfaceDetail(opened.surfaceId);
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(detail.panes[0]?.session, null);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
