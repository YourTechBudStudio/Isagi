import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { Effect } from 'effect';

import { RuntimeDatabase, type RuntimeDatabaseService } from '../../persistence/index.js';
import { agentSessions, surfacePanes } from '../../persistence/schema.js';
import { SurfaceService } from '../../surfaces/index.js';
import { insertWorktree, testLayer } from '../../surfaces/tests/test-support.js';
import { makeAgentSessionAdapter } from './adapters/agent-session.js';

/**
 * The compound spawn's resource half, against the **real** `SurfaceService`.
 *
 * The keyed owner contract itself — all four recovered states, destination and harness validation,
 * concurrent convergence — is proven directly against the owner elsewhere. What is unproven there,
 * and is this module's to establish, is the *integration*: that the operation layer names the
 * compound with its own `operation_key`, and that re-entering a recorded call position adopts the
 * existing pane and session rather than creating a second set in the person's workspace.
 */

const OPERATION_KEY = 'wop_2f9f2f0e-0000-4000-8000-000000000001';

/** A session owner that honours the key where the real one does, so the compound has three writes. */
function keyedAgentService() {
  return {
    startFresh: (input: {
      readonly worktreeId: number;
      readonly harness: string;
      readonly cwd: string;
      readonly creationKey?: string | undefined;
    }) =>
      Effect.gen(function* () {
        const database = yield* RuntimeDatabase;
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
        return { agentSessionId: inserted.id };
      }),
  };
}

function withRealSurfaces<A>(
  body: (input: {
    readonly worktreeId: number;
    readonly surfaces: SurfaceService;
  }) => Effect.Effect<A, unknown, RuntimeDatabaseService>,
) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-keyed-'));
  return Effect.runPromise(
    Effect.gen(function* () {
      const worktreeId = yield* insertWorktree('/repo/isagi');
      const surfaces = yield* SurfaceService;
      return yield* body({ worktreeId, surfaces });
    }).pipe(
      Effect.provide(testLayer(dataRoot, { agentService: keyedAgentService() as never })),
    ) as Effect.Effect<A, never>,
  ).finally(() => rmSync(dataRoot, { recursive: true, force: true }));
}

/** Only the surface half of the adapter is exercised here; the rest would need a live PTY. */
function adapterFor(surfaces: SurfaceService) {
  return makeAgentSessionAdapter({
    surfaces,
    agents: undefined as never,
    pty: undefined as never,
    artifacts: undefined as never,
    observer: undefined as never,
  });
}

test('the operation key names the whole compound, and re-entry adopts it', async () => {
  await withRealSurfaces(({ worktreeId, surfaces }) =>
    Effect.gen(function* () {
      const surface = yield* surfaces.createSurface({
        worktreeId,
        initialPane: { kind: 'agent_session', harness: 'claude' },
      });
      const adapter = adapterFor(surfaces);
      const created = yield* adapter.createKeyedSession({
        creationKey: OPERATION_KEY,
        worktreeId,
        surfaceId: surface.surfaceId,
        harness: 'claude',
      });

      const database = yield* RuntimeDatabase;
      const pane = yield* database.use('test_read_pane', (db) =>
        db.select().from(surfacePanes).where(eq(surfacePanes.id, created.paneId)).get(),
      );
      // The operation's own key, not a second identifier space invented for correlation.
      assert.equal(pane?.creationKey, OPERATION_KEY);
      const session = yield* database.use('test_read_session', (db) =>
        db.select().from(agentSessions).where(eq(agentSessions.id, created.agentSessionId)).get(),
      );
      assert.equal(session?.creationKey, OPERATION_KEY, 'one key names the whole compound');

      // Re-entering the recorded call position — a resumed callback, or recovery from a crash before
      // the stage was written — must adopt rather than split a second pane.
      const readopted = yield* adapter.createKeyedSession({
        creationKey: OPERATION_KEY,
        worktreeId,
        surfaceId: surface.surfaceId,
        harness: 'claude',
      });
      assert.deepEqual(readopted, created);

      const panes = yield* database.use('test_count_panes', (db) =>
        db.select().from(surfacePanes).all(),
      );
      const keyed = panes.filter((candidate) => candidate.creationKey === OPERATION_KEY);
      assert.equal(keyed.length, 1, 'exactly one pane exists under this operation');
      const sessions = yield* database.use('test_count_sessions', (db) =>
        db.select().from(agentSessions).all(),
      );
      assert.equal(
        sessions.filter((candidate) => candidate.creationKey === OPERATION_KEY).length,
        1,
        'and exactly one agent session',
      );
    }),
  );
});

test('the adapter resolves the session through the key, not through the returned layout', async () => {
  await withRealSurfaces(({ worktreeId, surfaces }) =>
    Effect.gen(function* () {
      const surface = yield* surfaces.createSurface({
        worktreeId,
        initialPane: { kind: 'agent_session', harness: 'claude' },
      });
      const adapter = adapterFor(surfaces);
      const created = yield* adapter.createKeyedSession({
        creationKey: OPERATION_KEY,
        worktreeId,
        surfaceId: surface.surfaceId,
        harness: 'claude',
      });

      // The owner is the authority on what this key names. Scanning the layout for a pane instead
      // would answer a different question — "what got created here" rather than "what does this
      // operation own" — and the two diverge the moment a second split lands.
      const keyed = yield* surfaces.findByCreationKey(OPERATION_KEY);
      assert.equal(keyed.kind, 'complete');
      assert.equal(keyed.kind === 'complete' && keyed.paneId, created.paneId);
      assert.equal(keyed.kind === 'complete' && keyed.session.sessionId, created.agentSessionId);
    }),
  );
});
