import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { Effect, Either } from 'effect';

import { type AgentSessionServiceShape } from '../../agent-sessions/index.js';
import { RuntimeDatabase } from '../../persistence/index.js';
import { surfacePanes } from '../../persistence/schema.js';
import { SurfaceError, SurfaceService } from '../index.js';
import {
  agentSessionRowForTest,
  insertAgentSessionForWorktree,
  insertWorktree,
  testLayer,
} from './test-support.js';

test('create pane session assigns a new agent session to the pane', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-claim-start-fresh-'));
  let startFreshInput: Parameters<AgentSessionServiceShape['startFresh']>[0] | null = null;
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const surface = yield* surfaces.createSinglePaneSurface({
          worktreeId,

          titleBase: 'Agent',
        });
        const claim = yield* surfaces.createPaneSession({
          worktreeId,
          create: { kind: 'agent_session', paneId: surface.paneId, harness: 'pi' },
        });
        const database = yield* RuntimeDatabase;
        const pane = yield* database.use('test_find_claimed_pane', (db) =>
          db.select().from(surfacePanes).where(eq(surfacePanes.id, surface.paneId)).get(),
        );
        return { claim, pane };
      }).pipe(
        Effect.provide(
          testLayer(dataRoot, {
            agentService: {
              startFresh: (input) =>
                Effect.sync(() => {
                  startFreshInput = input;
                  return { agentSessionId: 123 };
                }),
            },
          }),
        ),
      ),
    );

    assert.deepEqual(startFreshInput, {
      worktreeId: output.claim.worktreeId,
      harness: 'pi',
      cwd: '/repo/isagi',
    });
    assert.equal(output.pane?.sessionKind, 'agent_session');
    assert.equal(output.pane?.sessionId, 123);
    assert.deepEqual(output.claim.session, { kind: 'agent_session', agentSessionId: 123 });
    assert.equal(typeof output.claim.attachToken, 'string');
    assert.ok(output.claim.attachToken.length > 0);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('claim pane session rejects sessions from another worktree', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-claim-worktree-mismatch-'));
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const surface = yield* surfaces.createSinglePaneSurface({
          worktreeId,

          titleBase: 'Agent',
        });
        return yield* surfaces
          .claimPaneSession({
            worktreeId,
            claim: { action: 'claim_agent_session', paneId: surface.paneId, agentSessionId: 77 },
          })
          .pipe(Effect.either);
      }).pipe(
        Effect.provide(
          testLayer(dataRoot, {
            agentService: {
              get: () => Effect.succeed(agentSessionRowForTest({ id: 77, worktreeId: 999 })),
            },
          }),
        ),
      ),
    );

    assert.equal(Either.isLeft(result), true);
    if (Either.isLeft(result)) {
      assert.equal(result.left instanceof SurfaceError, true);
      assert.equal((result.left as SurfaceError).code, 'session_worktree_mismatch');
    }
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('surface detail composes pane-owned agent session placement', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-pane-session-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const surface = yield* surfaces.createSinglePaneSurface({
          worktreeId,

          titleBase: 'Pi',
        });
        const agentSessionId = yield* insertAgentSessionForWorktree({
          worktreeId,
          paneId: surface.paneId,
        });
        const detail = yield* surfaces.getSurfaceDetail(surface.surfaceId);
        return { agentSessionId, detail };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    const paneSession = output.detail.panes[0]?.session;
    assert.equal(paneSession?.kind, 'agent_session');
    assert.equal(paneSession?.agentSession.id, output.agentSessionId);
    assert.equal(paneSession?.agentSession.paneId, output.detail.panes[0]?.id);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
