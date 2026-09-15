import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { Effect } from 'effect';

import { RuntimeDatabase, type RuntimeDatabaseService } from '../../persistence/index.js';
import { agentSessions, surfacePanes } from '../../persistence/schema.js';
import { SurfaceService } from '../index.js';
import { insertWorktree, testLayer } from './test-support.js';

/**
 * Keyed creation: idempotent *completion*, not idempotent creation.
 *
 * Splitting a pane, creating its session and associating the two are three separate writes, so a
 * crash can land between any of them. The states these tests drive are the real ones a crash
 * produces, and each is reached by deleting exactly the row the crash would not have written.
 */

const KEY = 'wop_11111111-1111-1111-1111-111111111111';

/** A fake session owner that honours the key by writing it where the real one does. */
function keyedAgentService(allocated: { id: number }) {
  return {
    startFresh: (input: {
      readonly worktreeId: number;
      readonly harness: string;
      readonly cwd: string;
      readonly creationKey?: string | undefined;
    }) =>
      Effect.gen(function* () {
        const database = yield* RuntimeDatabase;
        // The owner's own idempotent completion, which its own tests cover directly; reproduced
        // here only so the compound has a session owner that behaves like the real one.
        const existing = input.creationKey
          ? yield* database.use('test_find_keyed_agent_session', (db) =>
              db
                .select()
                .from(agentSessions)
                .where(eq(agentSessions.creationKey, input.creationKey!))
                .get(),
            )
          : undefined;
        if (existing) return { agentSessionId: existing.id };
        const now = new Date().toISOString();
        const inserted = yield* database.use('test_create_keyed_agent_session', (db) =>
          db
            .insert(agentSessions)
            .values({
              worktreeId: input.worktreeId,
              harness: 'claude',
              cwd: input.cwd,
              activePtyProcessId: null,
              creationKey: input.creationKey ?? null,
              createdAt: now,
              updatedAt: now,
              lastSeenAt: null,
            })
            .returning({ id: agentSessions.id })
            .get(),
        );
        allocated.id = inserted.id;
        return { agentSessionId: inserted.id };
      }),
  };
}

function withSurfaces<A>(
  body: (input: {
    readonly worktreeId: number;
    readonly surfaces: SurfaceService;
  }) => Effect.Effect<A, unknown, RuntimeDatabaseService>,
) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-keyed-'));
  const allocated = { id: 0 };
  return Effect.runPromise(
    Effect.gen(function* () {
      const worktreeId = yield* insertWorktree('/repo/isagi');
      const surfaces = yield* SurfaceService;
      return yield* body({ worktreeId, surfaces });
    }).pipe(
      Effect.provide(testLayer(dataRoot, { agentService: keyedAgentService(allocated) as never })),
    ) as Effect.Effect<A, never>,
  ).finally(() => rmSync(dataRoot, { recursive: true, force: true }));
}

test('an unkeyed split behaves exactly as before and records no key', async () => {
  await withSurfaces(({ worktreeId, surfaces }) =>
    Effect.gen(function* () {
      const surface = yield* surfaces.createSurface({
        worktreeId,
        initialPane: { kind: 'agent_session', harness: 'claude' },
      });
      const split = yield* surfaces.splitPane({
        worktreeId,
        split: {
          paneId: surface.paneId,
          direction: 'right',
          newPane: { kind: 'agent_session', harness: 'claude' },
        },
      });
      const database = yield* RuntimeDatabase;
      const pane = yield* database.use('test_read_pane', (db) =>
        db.select().from(surfacePanes).where(eq(surfacePanes.id, split.paneId)).get(),
      );
      assert.equal(pane?.creationKey, null);
      assert.equal(
        yield* Effect.map(surfaces.findByCreationKey(KEY), (state) => state.kind),
        'absent',
      );
    }),
  );
});

test('a keyed split converges to one pane and one session across repeated calls', async () => {
  await withSurfaces(({ worktreeId, surfaces }) =>
    Effect.gen(function* () {
      const surface = yield* surfaces.createSurface({
        worktreeId,
        initialPane: { kind: 'agent_session', harness: 'claude' },
      });
      const split = {
        paneId: surface.paneId,
        direction: 'right' as const,
        newPane: { kind: 'agent_session' as const, harness: 'claude' as const },
      };

      const first = yield* surfaces.splitPane({ worktreeId, split, creationKey: KEY });
      const complete = yield* surfaces.findByCreationKey(KEY);
      assert.equal(complete.kind, 'complete');

      // The re-entry a crashed workflow performs. It must not split again.
      const second = yield* surfaces.splitPane({ worktreeId, split, creationKey: KEY });
      assert.equal(second.paneId, first.paneId);

      const database = yield* RuntimeDatabase;
      const panes = yield* database.use('test_count_panes', (db) =>
        db.select().from(surfacePanes).where(eq(surfacePanes.creationKey, KEY)).all(),
      );
      assert.equal(panes.length, 1, 'one key names one pane');
      const sessions = yield* database.use('test_count_sessions', (db) =>
        db.select().from(agentSessions).where(eq(agentSessions.creationKey, KEY)).all(),
      );
      assert.equal(sessions.length, 1, 'and one session');
      assert.ok(second.title.length > 0);
    }),
  );
});

test('a crash between creating the session and assigning it is repaired, not repeated', async () => {
  await withSurfaces(({ worktreeId, surfaces }) =>
    Effect.gen(function* () {
      const surface = yield* surfaces.createSurface({
        worktreeId,
        initialPane: { kind: 'agent_session', harness: 'claude' },
      });
      const split = {
        paneId: surface.paneId,
        direction: 'right' as const,
        newPane: { kind: 'agent_session' as const, harness: 'claude' as const },
      };
      const created = yield* surfaces.splitPane({ worktreeId, split, creationKey: KEY });

      // Exactly the crash window: the pane exists, the session exists, and the association that
      // would have followed was never written.
      const database = yield* RuntimeDatabase;
      yield* database.use('test_unassign_pane', (db) => {
        db.update(surfacePanes)
          .set({ sessionKind: null, sessionId: null })
          .where(eq(surfacePanes.id, created.paneId))
          .run();
      });
      const state = yield* surfaces.findByCreationKey(KEY);
      assert.equal(state.kind, 'session_unassigned');

      const repaired = yield* surfaces.splitPane({ worktreeId, split, creationKey: KEY });
      assert.equal(repaired.paneId, created.paneId);

      const sessions = yield* database.use('test_count_sessions_after_repair', (db) =>
        db.select().from(agentSessions).where(eq(agentSessions.creationKey, KEY)).all(),
      );
      // The defect this state exists to prevent: creating a second agent session because the
      // *assignment* failed last time.
      assert.equal(sessions.length, 1);
      assert.equal(yield* Effect.map(surfaces.findByCreationKey(KEY), (s) => s.kind), 'complete');
    }),
  );
});

test('a crash between creating the pane and creating the session resumes against that pane', async () => {
  await withSurfaces(({ worktreeId, surfaces }) =>
    Effect.gen(function* () {
      const surface = yield* surfaces.createSurface({
        worktreeId,
        initialPane: { kind: 'agent_session', harness: 'claude' },
      });
      const split = {
        paneId: surface.paneId,
        direction: 'right' as const,
        newPane: { kind: 'agent_session' as const, harness: 'claude' as const },
      };
      const created = yield* surfaces.splitPane({ worktreeId, split, creationKey: KEY });

      const database = yield* RuntimeDatabase;
      yield* database.use('test_drop_keyed_session', (db) => {
        db.update(surfacePanes)
          .set({ sessionKind: null, sessionId: null })
          .where(eq(surfacePanes.id, created.paneId))
          .run();
        db.delete(agentSessions).where(eq(agentSessions.creationKey, KEY)).run();
      });
      assert.equal(yield* Effect.map(surfaces.findByCreationKey(KEY), (s) => s.kind), 'pane_only');

      const resumed = yield* surfaces.splitPane({ worktreeId, split, creationKey: KEY });
      assert.equal(resumed.paneId, created.paneId, 'the existing pane is reused, not duplicated');

      const panes = yield* database.use('test_count_panes_after_resume', (db) =>
        db.select().from(surfacePanes).where(eq(surfacePanes.creationKey, KEY)).all(),
      );
      assert.equal(panes.length, 1);
    }),
  );
});

test('a keyed component the person deleted is recreated, because the key is intent', async () => {
  await withSurfaces(({ worktreeId, surfaces }) =>
    Effect.gen(function* () {
      const surface = yield* surfaces.createSurface({
        worktreeId,
        initialPane: { kind: 'agent_session', harness: 'claude' },
      });
      const split = {
        paneId: surface.paneId,
        direction: 'right' as const,
        newPane: { kind: 'agent_session' as const, harness: 'claude' as const },
      };
      const created = yield* surfaces.splitPane({ worktreeId, split, creationKey: KEY });

      // The person closed the pane between the crash and the recovery. The key describes what was
      // intended, not a live handle, so this is `absent` and starts over.
      const database = yield* RuntimeDatabase;
      yield* database.use('test_delete_keyed_pane', (db) => {
        db.delete(surfacePanes).where(eq(surfacePanes.id, created.paneId)).run();
        db.delete(agentSessions).where(eq(agentSessions.creationKey, KEY)).run();
      });
      assert.equal(yield* Effect.map(surfaces.findByCreationKey(KEY), (s) => s.kind), 'absent');

      const recreated = yield* surfaces.splitPane({ worktreeId, split, creationKey: KEY });
      assert.notEqual(recreated.paneId, created.paneId);
      assert.equal(yield* Effect.map(surfaces.findByCreationKey(KEY), (s) => s.kind), 'complete');
    }),
  );
});

test('the unique index makes convergence structural, not merely conventional', async () => {
  await withSurfaces(({ worktreeId, surfaces }) =>
    Effect.gen(function* () {
      const surface = yield* surfaces.createSurface({
        worktreeId,
        initialPane: { kind: 'agent_session', harness: 'claude' },
      });
      yield* surfaces.splitPane({
        worktreeId,
        split: {
          paneId: surface.paneId,
          direction: 'right',
          newPane: { kind: 'agent_session', harness: 'claude' },
        },
        creationKey: KEY,
      });

      // A second writer that skipped the lookup — the shape a genuinely concurrent retry takes — is
      // refused by the database rather than by a check that happened to run first.
      const database = yield* RuntimeDatabase;
      const conflict = yield* Effect.either(
        database.use('test_duplicate_keyed_pane', (db) => {
          db.insert(surfacePanes)
            .values({
              surfaceId: surface.surfaceId,
              title: 'duplicate',
              sortOrder: 99,
              sessionKind: null,
              sessionId: null,
              creationKey: KEY,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            })
            .run();
        }),
      );
      assert.equal(conflict._tag, 'Left');
    }),
  );
});

test('a key reused against a different destination is refused without mutating either', async () => {
  await withSurfaces(({ worktreeId, surfaces }) =>
    Effect.gen(function* () {
      const first = yield* surfaces.createSurface({
        worktreeId,
        initialPane: { kind: 'agent_session', harness: 'claude' },
      });
      const keyed = yield* surfaces.splitPane({
        worktreeId,
        split: {
          paneId: first.paneId,
          direction: 'right',
          newPane: { kind: 'agent_session', harness: 'claude' },
        },
        creationKey: KEY,
      });

      // A second destination, and the same key pointed at it. The key names a pane on the first
      // surface, so this is a mismatched request rather than a recovery.
      const second = yield* surfaces.createSurface({
        worktreeId,
        initialPane: { kind: 'agent_session', harness: 'claude' },
      });
      const database = yield* RuntimeDatabase;
      const before = yield* database.use('test_read_panes_before_mismatch', (db) =>
        db.select().from(surfacePanes).all(),
      );

      const refused = yield* Effect.either(
        surfaces.createPaneSession({
          worktreeId,
          create: { kind: 'agent_session', paneId: second.paneId, harness: 'claude' },
          creationKey: KEY,
        }),
      );
      assert.equal(refused._tag, 'Left');
      assert.equal(
        refused._tag === 'Left' ? (refused.left as { code: string }).code : null,
        'creation_key_mismatch',
      );

      // Neither destination moved: no association written, no focus changed, no second session.
      const after = yield* database.use('test_read_panes_after_mismatch', (db) =>
        db.select().from(surfacePanes).all(),
      );
      assert.deepEqual(after, before);
      const sessions = yield* database.use('test_count_sessions_after_mismatch', (db) =>
        db.select().from(agentSessions).where(eq(agentSessions.creationKey, KEY)).all(),
      );
      assert.equal(sessions.length, 1);
      assert.equal(keyed.paneId, before.find((pane) => pane.creationKey === KEY)?.id);
    }),
  );
});

test('the repair path answers to the destination check too', async () => {
  await withSurfaces(({ worktreeId, surfaces }) =>
    Effect.gen(function* () {
      const first = yield* surfaces.createSurface({
        worktreeId,
        initialPane: { kind: 'agent_session', harness: 'claude' },
      });
      const keyed = yield* surfaces.splitPane({
        worktreeId,
        split: {
          paneId: first.paneId,
          direction: 'right',
          newPane: { kind: 'agent_session', harness: 'claude' },
        },
        creationKey: KEY,
      });

      // Drop the association so the key resolves to `session_unassigned` rather than `complete`,
      // then aim the repair at the wrong pane. A mismatch must be refused on this path as well —
      // otherwise the repair would assign the recovered session to a pane nobody asked about.
      const database = yield* RuntimeDatabase;
      yield* database.use('test_unassign_for_mismatch', (db) => {
        db.update(surfacePanes)
          .set({ sessionKind: null, sessionId: null })
          .where(eq(surfacePanes.id, keyed.paneId))
          .run();
      });
      assert.equal(
        yield* Effect.map(surfaces.findByCreationKey(KEY), (s) => s.kind),
        'session_unassigned',
      );

      const second = yield* surfaces.createSurface({
        worktreeId,
        initialPane: { kind: 'agent_session', harness: 'claude' },
      });
      const refused = yield* Effect.either(
        surfaces.createPaneSession({
          worktreeId,
          create: { kind: 'agent_session', paneId: second.paneId, harness: 'claude' },
          creationKey: KEY,
        }),
      );
      assert.equal(refused._tag, 'Left');
      assert.equal(
        refused._tag === 'Left' ? (refused.left as { code: string }).code : null,
        'creation_key_mismatch',
      );
      assert.equal(
        yield* Effect.map(surfaces.findByCreationKey(KEY), (s) => s.kind),
        'session_unassigned',
      );
    }),
  );
});

test('two overlapping keyed splits both succeed on the same pane and session', async () => {
  await withSurfaces(({ worktreeId, surfaces }) =>
    Effect.gen(function* () {
      const surface = yield* surfaces.createSurface({
        worktreeId,
        initialPane: { kind: 'agent_session', harness: 'claude' },
      });
      const split = {
        paneId: surface.paneId,
        direction: 'right' as const,
        newPane: { kind: 'agent_session' as const, harness: 'claude' as const },
      };

      // Both callers run the real service path. Whether they genuinely interleave is up to the
      // runtime — SQLite is synchronous — so this proves the *outcome* is the same either way;
      // the test below forces the conflict deterministically.
      const [first, second] = yield* Effect.all(
        [
          surfaces.splitPane({ worktreeId, split, creationKey: KEY }),
          surfaces.splitPane({ worktreeId, split, creationKey: KEY }),
        ],
        { concurrency: 2 },
      );

      assert.equal(first.paneId, second.paneId, 'both callers get the same pane');
      assert.equal(first.surfaceId, second.surfaceId);

      const database = yield* RuntimeDatabase;
      const panes = yield* database.use('test_count_panes_after_race', (db) =>
        db.select().from(surfacePanes).where(eq(surfacePanes.creationKey, KEY)).all(),
      );
      assert.equal(panes.length, 1, 'one key, one pane');
      const sessions = yield* database.use('test_count_sessions_after_race', (db) =>
        db.select().from(agentSessions).where(eq(agentSessions.creationKey, KEY)).all(),
      );
      assert.equal(sessions.length, 1, 'and one session');

      // The loser completed against the winner rather than returning a half-made association.
      assert.equal(yield* Effect.map(surfaces.findByCreationKey(KEY), (s) => s.kind), 'complete');
      assert.equal(panes[0]!.sessionKind, 'agent_session');
      assert.equal(panes[0]!.sessionId, sessions[0]!.id);
    }),
  );
});

test('a key reused for a different harness is refused, in every recovered state', async () => {
  await withSurfaces(({ worktreeId, surfaces }) =>
    Effect.gen(function* () {
      const surface = yield* surfaces.createSurface({
        worktreeId,
        initialPane: { kind: 'agent_session', harness: 'claude' },
      });
      const created = yield* surfaces.splitPane({
        worktreeId,
        split: {
          paneId: surface.paneId,
          direction: 'right',
          newPane: { kind: 'agent_session', harness: 'claude' },
        },
        creationKey: KEY,
      });

      const database = yield* RuntimeDatabase;
      const sessionsBefore = yield* database.use('test_sessions_before_harness_reuse', (db) =>
        db.select().from(agentSessions).all(),
      );

      // `complete`: the key already names a claude session, and this asks for a codex one. Adopting
      // it would hand the caller a live agent of the wrong kind while reporting recovery.
      const mismatched = yield* Effect.either(
        surfaces.createPaneSession({
          worktreeId,
          create: { kind: 'agent_session', paneId: created.paneId, harness: 'codex' },
          creationKey: KEY,
        }),
      );
      assert.equal(mismatched._tag, 'Left');
      assert.equal(
        mismatched._tag === 'Left' ? (mismatched.left as { code: string }).code : null,
        'creation_key_mismatch',
      );

      // `session_unassigned`: the repair path answers to the same check. Only `absent` creates, and
      // only creation validated the harness before this.
      yield* database.use('test_unassign_for_harness_reuse', (db) => {
        db.update(surfacePanes)
          .set({ sessionKind: null, sessionId: null })
          .where(eq(surfacePanes.id, created.paneId))
          .run();
      });
      const repairMismatch = yield* Effect.either(
        surfaces.createPaneSession({
          worktreeId,
          create: { kind: 'agent_session', paneId: created.paneId, harness: 'codex' },
          creationKey: KEY,
        }),
      );
      assert.equal(repairMismatch._tag, 'Left');
      assert.equal(
        repairMismatch._tag === 'Left' ? (repairMismatch.left as { code: string }).code : null,
        'creation_key_mismatch',
      );

      // A terminal pane where the key named an agent session is the same class of mismatch.
      const kindMismatch = yield* Effect.either(
        surfaces.createPaneSession({
          worktreeId,
          create: { kind: 'terminal_session', paneId: created.paneId },
          creationKey: KEY,
        }),
      );
      assert.equal(kindMismatch._tag, 'Left');

      // No refusal created a session or touched the association.
      assert.deepEqual(
        yield* database.use('test_sessions_after_harness_reuse', (db) =>
          db.select().from(agentSessions).all(),
        ),
        sessionsBefore,
      );
    }),
  );
});

test('a key reused against a different surface is refused before the destination is rewritten', async () => {
  await withSurfaces(({ worktreeId, surfaces }) =>
    Effect.gen(function* () {
      const first = yield* surfaces.createSurface({
        worktreeId,
        initialPane: { kind: 'agent_session', harness: 'claude' },
      });
      yield* surfaces.splitPane({
        worktreeId,
        split: {
          paneId: first.paneId,
          direction: 'right',
          newPane: { kind: 'agent_session', harness: 'claude' },
        },
        creationKey: KEY,
      });

      // A split on a *different* surface under the same key. Resuming rewrites the requested pane
      // to the recovered one, so a check made after that rewrite would compare the recovered pane
      // to itself and silently return the earlier association on the wrong surface.
      const second = yield* surfaces.createSurface({
        worktreeId,
        initialPane: { kind: 'agent_session', harness: 'claude' },
      });
      const database = yield* RuntimeDatabase;
      const before = yield* database.use('test_panes_before_surface_reuse', (db) =>
        db.select().from(surfacePanes).all(),
      );

      const refused = yield* Effect.either(
        surfaces.splitPane({
          worktreeId,
          split: {
            paneId: second.paneId,
            direction: 'right',
            newPane: { kind: 'agent_session', harness: 'claude' },
          },
          creationKey: KEY,
        }),
      );
      assert.equal(refused._tag, 'Left');
      assert.equal(
        refused._tag === 'Left' ? (refused.left as { code: string }).code : null,
        'creation_key_mismatch',
      );

      assert.deepEqual(
        yield* database.use('test_panes_after_surface_reuse', (db) =>
          db.select().from(surfacePanes).all(),
        ),
        before,
        'neither surface was split and no association moved',
      );
    }),
  );
});

test('losing the keyed race converges on the winner instead of failing', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-keyed-race-'));
  const allocated = { id: 0 };
  let raced = false;
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const database = yield* RuntimeDatabase;
        const surface = yield* surfaces.createSurface({
          worktreeId,
          initialPane: { kind: 'agent_session', harness: 'claude' },
        });

        const result = yield* surfaces.splitPane({
          worktreeId,
          split: {
            paneId: surface.paneId,
            direction: 'right',
            newPane: { kind: 'agent_session', harness: 'claude' },
          },
          creationKey: KEY,
        });

        assert.equal(raced, true, 'the competing pane really was inserted first');

        // The caller that lost still gets a successful, complete association — against the pane the
        // winner created, not one of its own.
        const panes = yield* database.use('test_panes_after_lost_race', (db) =>
          db.select().from(surfacePanes).where(eq(surfacePanes.creationKey, KEY)).all(),
        );
        assert.equal(panes.length, 1, 'the unique index still admits exactly one');
        assert.equal(result.paneId, panes[0]!.id, 'and the loser completed against it');
        assert.equal(panes[0]!.sessionKind, 'agent_session');
        assert.equal(panes[0]!.sessionId, allocated.id);
        assert.equal(
          yield* Effect.map(surfaces.findByCreationKey(KEY), (state) => state.kind),
          'complete',
        );
      }).pipe(
        Effect.provide(
          testLayer(dataRoot, {
            agentService: keyedAgentService(allocated) as never,
            // Another caller wins the key between this one's read and its write. Without the
            // service treating that conflict as a signal to re-read, this call would surface a raw
            // unique-constraint DatabaseError to a caller that did nothing wrong.
            decorateSurfaceRepository: (inner) => ({
              ...inner,
              splitSurfacePane: (input) =>
                Effect.gen(function* () {
                  if (input.creationKey && !raced) {
                    raced = true;
                    const winner = yield* inner.splitSurfacePane({
                      ...input,
                      creationKey: input.creationKey,
                    });
                    assert.ok(winner, 'the competing split should succeed');
                  }
                  return yield* inner.splitSurfacePane(input);
                }),
            }),
          }),
        ),
      ) as Effect.Effect<void, never>,
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
