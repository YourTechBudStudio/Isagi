import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { Deferred, Effect, Fiber, Result } from 'effect';

import {
  EditorContextRepository,
  insertPtyProcess as insertEditorPtyProcess,
} from '../../../editor/testing.js';
import { tapInternalEvents } from '../../../platform/events/testing.js';
import { DatabaseError, RuntimeDatabase } from '../../../platform/persistence/index.js';
import { SurfaceError, SurfaceService } from '../../index.js';
import { SessionLifecycle } from '../../sessions/lifecycle.js';
import { surfacePanes, terminalSessions } from '../../tables.js';
import type { TerminalSessionService } from '../../terminal-sessions/service.js';
import { insertWorktree, testLayer } from '../../testing.js';
import { SurfaceRepository } from '../repository.js';

/**
 * Closing a surface racing the work that fills it. Each test forces one
 * interleaving deterministically: SQLite is synchronous here, so without a
 * suspension or a stale read the operations would never overlap.
 */

test('a session another pane claimed during startup survives its first pane being closed', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-close-race-claimed-'));
  const created = Effect.runSync(Deferred.make<number>());
  const resume = Effect.runSync(Deferred.make<void>());
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const repository = yield* SurfaceRepository;
        const closing = yield* surfaces.createEmptySurface({ worktreeId, titleBase: 'Closing' });
        const other = yield* surfaces.createEmptySurface({ worktreeId, titleBase: 'Other' });
        const spare = yield* repository.startSurfacePane({
          surfaceId: other.surfaceId,
          titleBase: 'Spare',
        });
        if (spare.status !== 'started') throw new Error('spare pane was not started');

        const starting = yield* Effect.forkChild(
          surfaces.startPane({
            surfaceId: closing.surfaceId,
            start: { newPane: { kind: 'terminal_session' } },
          }),
        );
        const sessionId = yield* Deferred.await(created);
        // Another pane claims the new, not-yet-started session…
        yield* surfaces.claimPaneSession({
          worktreeId,
          claim: {
            action: 'claim_terminal_session',
            paneId: spare.paneId,
            terminalSessionId: sessionId,
          },
        });
        // …and the pane it was created for goes away.
        yield* surfaces.deleteSurface(closing.surfaceId);
        yield* Deferred.succeed(resume, undefined);
        const started = yield* Effect.result(Fiber.join(starting));

        const database = yield* RuntimeDatabase;
        const rows = yield* database.use('test_claimed_session_rows', (db) => ({
          session: db
            .select()
            .from(terminalSessions)
            .where(eq(terminalSessions.id, sessionId))
            .get(),
          spare: db.select().from(surfacePanes).where(eq(surfacePanes.id, spare.paneId)).get(),
        }));
        return { started, sessionId, rows };
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
                        Effect.andThen(Deferred.await(resume)),
                      ),
                    ),
                  ),
            }),
          }),
        ),
      ),
    );

    assert.ok(Result.isFailure(output.started));
    assert.ok(output.started.failure instanceof SurfaceError);
    assert.equal(output.started.failure.code, 'pane_not_found');
    assert.ok(output.rows.session, 'the claimed session is kept');
    assert.equal(output.rows.spare?.sessionKind, 'terminal_session');
    assert.equal(output.rows.spare?.sessionId, output.sessionId);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('an editor placed into an empty surface after a close looked at it is still released', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-close-race-editor-'));
  const terminated: number[] = [];
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const empty = yield* surfaces.createEmptySurface({ worktreeId, titleBase: 'Scratch' });
        const opened = yield* surfaces.openEditor({ worktreeId, intoSurfaceId: empty.surfaceId });
        const editors = yield* EditorContextRepository;
        const ptyProcessId = yield* insertEditorPtyProcess();
        yield* editors.markAttemptInProgress(opened.editorContextId);
        yield* editors.installIncarnation({
          editorContextId: opened.editorContextId,
          handoff: {
            ptyProcessId,
            endpointHost: '127.0.0.1',
            endpointPort: 41_234,
            sessionSocketPath: '/tmp/isagi-editor-test.sock',
          },
        });
        const deleted = yield* surfaces.deleteSurface(empty.surfaceId);
        return {
          empty,
          ptyProcessId,
          deleted,
          row: yield* editors.find(opened.editorContextId),
        };
      }).pipe(
        Effect.provide(
          testLayer(dataRoot, {
            // The close read the surface while it was still empty, so it chose
            // the path that holds no editor lock; the editor was placed before
            // its transaction committed.
            decorateSurfaceRepository: (inner) => ({
              ...inner,
              findSurfaceDeleteTarget: (surfaceId) =>
                inner
                  .findSurfaceDeleteTarget(surfaceId)
                  .pipe(Effect.map((target) => target && { ...target, panes: [] })),
            }),
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

    assert.equal(output.deleted.deletedSurfaceId, output.empty.surfaceId);
    assert.deepEqual(terminated, [output.ptyProcessId]);
    assert.equal(output.row?.activePtyProcessId, null);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('a committed delete is published even when its cleanup lookup fails', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-close-race-lookup-fails-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const empty = yield* surfaces.createEmptySurface({ worktreeId, titleBase: 'Scratch' });
        const subscription = yield* tapInternalEvents(['surface_changed']);
        const deleted = yield* Effect.result(surfaces.deleteSurface(empty.surfaceId));
        const event = yield* subscription.take;
        yield* subscription.unsubscribe;
        return { deleted, event, surfaceId: empty.surfaceId };
      }).pipe(
        Effect.scoped,
        Effect.provide(
          testLayer(dataRoot, {
            decorateSurfaceRepository: (inner) => ({
              ...inner,
              listSessionsBoundTo: () =>
                Effect.fail(
                  new DatabaseError({
                    operation: 'list_sessions_bound_to_panes',
                    cause: new Error('the session lookup failed after the delete committed'),
                  }),
                ),
            }),
          }),
        ),
      ),
    );

    assert.ok(Result.isFailure(output.deleted), 'the failed cleanup is still reported');
    assert.equal(output.event.type, 'surface_changed');
    assert.equal(output.event.payload.surfaceId, output.surfaceId);
    assert.equal(output.event.payload.change, 'deleted');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('a claim that validated a session before orphan GC deleted it refuses to bind the missing row', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-close-race-claim-gc-'));
  const validated = Effect.runSync(Deferred.make<void>());
  const resume = Effect.runSync(Deferred.make<void>());
  let terminals: TerminalSessionService['Service'] | null = null;
  let pauseNextGet = false;
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const repository = yield* SurfaceRepository;
        const service = terminals as TerminalSessionService['Service'] | null;
        if (!service) throw new Error('the terminal service was not built');
        const { terminalSessionId } = yield* service.startFresh({ worktreeId, cwd: '/repo/isagi' });
        const other = yield* surfaces.createEmptySurface({ worktreeId, titleBase: 'Other' });
        const spare = yield* repository.startSurfacePane({
          surfaceId: other.surfaceId,
          titleBase: 'Spare',
        });
        if (spare.status !== 'started') throw new Error('spare pane was not started');

        pauseNextGet = true;
        const claiming = yield* Effect.forkChild(
          surfaces.claimPaneSession({
            worktreeId,
            claim: { action: 'claim_terminal_session', paneId: spare.paneId, terminalSessionId },
          }),
        );
        yield* Deferred.await(validated);
        // Unplaced at this instant, so orphan GC is free to delete it.
        const database = yield* RuntimeDatabase;
        yield* database.use('test_claim_gc_delete', (db) => {
          db.delete(terminalSessions).where(eq(terminalSessions.id, terminalSessionId)).run();
        });
        yield* Deferred.succeed(resume, undefined);
        const claimed = yield* Effect.result(Fiber.join(claiming));

        const pane = yield* database.use('test_claim_gc_pane', (db) =>
          db.select().from(surfacePanes).where(eq(surfacePanes.id, spare.paneId)).get(),
        );
        return { claimed, pane };
      }).pipe(
        Effect.provide(
          testLayer(dataRoot, {
            decorateTerminalService: (inner) => {
              terminals = inner;
              return {
                ...inner,
                // The claim validates the session through `get`; it is held
                // right after that validation, before the binding transaction.
                get: (id) =>
                  inner.get(id).pipe(
                    Effect.tap(() =>
                      pauseNextGet
                        ? Effect.sync(() => {
                            pauseNextGet = false;
                          }).pipe(
                            Effect.andThen(Deferred.succeed(validated, undefined)),
                            Effect.andThen(Deferred.await(resume)),
                          )
                        : Effect.void,
                    ),
                  ),
              };
            },
          }),
        ),
      ),
    );

    assert.ok(Result.isFailure(output.claimed));
    assert.ok(output.claimed.failure instanceof SurfaceError);
    assert.equal(output.claimed.failure.code, 'session_not_found');
    assert.equal(output.pane?.sessionId, null, 'the pane never points at the deleted row');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('a claim waits for a holder of the session lock that found the session unplaced', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-close-race-claim-waits-'));
  const decided = Effect.runSync(Deferred.make<void>());
  const release = Effect.runSync(Deferred.make<void>());
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const repository = yield* SurfaceRepository;
        const lifecycle = yield* SessionLifecycle;
        // An agent session whose pane is gone: its surface was closed.
        const closing = yield* surfaces.createEmptySurface({ worktreeId, titleBase: 'Closing' });
        const started = yield* surfaces.startPane({
          surfaceId: closing.surfaceId,
          start: { newPane: { kind: 'agent_session', harness: 'claude' } },
        });
        yield* surfaces.deleteSurfacePane({ surfaceId: closing.surfaceId, paneId: started.paneId });
        const other = yield* surfaces.createEmptySurface({ worktreeId, titleBase: 'Other' });
        const spare = yield* repository.startSurfacePane({
          surfaceId: other.surfaceId,
          titleBase: 'Spare',
        });
        if (spare.status !== 'started') throw new Error('spare pane was not started');
        const key = { kind: 'agent_session' as const, sessionId: 77 };

        // The holder is `stopUnlessPlaced`'s shape: it reads "unplaced" and is
        // held there, standing in for the stop that follows.
        const holder = yield* Effect.forkChild(
          lifecycle.withRestoreLock(
            key,
            Effect.gen(function* () {
              const placement = yield* repository.findPaneForSession({
                sessionKind: 'agent_session',
                sessionId: 77,
              });
              yield* Deferred.succeed(decided, undefined);
              yield* Deferred.await(release);
              return placement;
            }),
          ),
        );
        yield* Deferred.await(decided);
        const claiming = yield* Effect.forkChild(
          surfaces.claimPaneSession({
            worktreeId,
            claim: {
              action: 'claim_agent_session',
              paneId: spare.paneId,
              agentSessionId: 77,
              expectedInteractionGeneration: 0,
            },
          }),
        );
        for (let turn = 0; turn < 20; turn += 1) yield* Effect.yieldNow;
        const whileHeld = yield* Effect.sync(() => claiming.pollUnsafe());
        const database = yield* RuntimeDatabase;
        const spareWhileHeld = yield* database.use('test_spare_while_held', (db) =>
          db.select().from(surfacePanes).where(eq(surfacePanes.id, spare.paneId)).get(),
        );
        yield* Deferred.succeed(release, undefined);
        const seenByHolder = yield* Fiber.join(holder);
        yield* Fiber.join(claiming);
        const spareAfter = yield* database.use('test_spare_after', (db) =>
          db.select().from(surfacePanes).where(eq(surfacePanes.id, spare.paneId)).get(),
        );
        return { whileHeld, spareWhileHeld, seenByHolder, spareAfter };
      }).pipe(
        Effect.provide(
          testLayer(dataRoot, {
            agentService: {
              startFresh: () => Effect.succeed({ agentSessionId: 77 }),
              get: () => Effect.succeed({ worktreeId: 1 } as never),
            },
          }),
        ),
      ),
    );

    assert.equal(output.seenByHolder, null, 'the holder decided on an unplaced session');
    assert.equal(output.whileHeld, undefined, 'the claim cannot bind while the decision stands');
    assert.equal(output.spareWhileHeld?.sessionId, null);
    assert.equal(output.spareAfter?.sessionId, 77, 'it binds once the holder is done');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
