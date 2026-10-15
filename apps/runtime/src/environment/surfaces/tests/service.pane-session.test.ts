import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { Effect, Fiber, Result } from 'effect';

import { RuntimeDatabase } from '../../../platform/persistence/index.js';
import type { AgentSessionService } from '../../agent-sessions/service.js';
import { SurfaceError, SurfaceService } from '../../index.js';
import { SessionLifecycle } from '../../sessions/lifecycle.js';
import { surfacePanes, terminalSessions } from '../../tables.js';
import {
  addPaneToSurface,
  agentSessionRowForTest,
  insertAgentSessionForWorktree,
  insertPtyProcess,
  insertWorktree,
  testLayer,
} from '../../testing.js';
import { SurfaceRepository } from '../repository.js';

test('create pane session assigns a new agent session to the pane', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-claim-start-fresh-'));
  let startFreshInput: Parameters<AgentSessionService['Service']['startFresh']>[0] | null = null;
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
          .pipe(Effect.result);
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

    assert.equal(Result.isFailure(result), true);
    if (Result.isFailure(result)) {
      assert.equal(result.failure instanceof SurfaceError, true);
      assert.equal((result.failure as SurfaceError).code, 'session_worktree_mismatch');
    }
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

/**
 * One automatic rejoin claim against the real service and repository. The agent session sits in
 * `rejoining` (the pane that claims it) unless `elsewhere`; the saved focus is on `other`.
 */
function rejoinScenario(input: {
  readonly process: { readonly id: number; readonly status: 'running' | 'exited' };
  readonly expected: string;
  readonly elsewhere?: boolean;
  /** An attachment registered before the claim, streaming this incarnation. */
  readonly holder?: 'pty:100' | 'pty:101';
  /** An explicit claim (Reconnect) lands first, and its socket has not connected yet. */
  readonly pendingExplicit?: boolean;
  /** Runs while the claim waits on the session's lock, after it has resolved the session. */
  readonly whileClaimWaits?: (context: {
    readonly process: { id: number; status: 'running' | 'exited' };
    readonly agentSessionId: number;
    readonly otherPaneId: number;
  }) => Effect.Effect<void, unknown, SurfaceRepository>;
}) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-rejoin-'));
  const process = { ...input.process };
  let moved = 0;
  return Effect.runPromise(
    Effect.gen(function* () {
      const worktreeId = yield* insertWorktree('/repo/isagi');
      const surfaces = yield* SurfaceService;
      const lifecycle = yield* SessionLifecycle;
      const repository = yield* SurfaceRepository;
      const rejoining = yield* surfaces.createSinglePaneSurface({ worktreeId, titleBase: 'Agent' });
      const other = yield* surfaces.createSinglePaneSurface({ worktreeId, titleBase: 'Agent' });
      const agentSessionId = yield* insertAgentSessionForWorktree({
        worktreeId,
        paneId: input.elsewhere ? other.paneId : rejoining.paneId,
      });
      const key = { kind: 'agent_session', sessionId: agentSessionId } as const;
      yield* repository.setEnvironmentFocus({
        worktreeId,
        activeSurfaceId: other.surfaceId,
        activePaneId: other.paneId,
      });
      if (input.holder)
        yield* lifecycle.registerActiveAttachment({
          key,
          handle: { moved: Effect.sync(() => moved++) },
          incarnation: input.holder,
        });
      const explicit = input.pendingExplicit
        ? yield* surfaces.claimPaneSession({
            worktreeId,
            claim: { action: 'claim_agent_session', paneId: rejoining.paneId, agentSessionId },
          })
        : null;
      const claim = surfaces
        .claimPaneSession({
          worktreeId,
          claim: {
            action: 'claim_agent_session',
            paneId: rejoining.paneId,
            agentSessionId,
            expectedProcessIncarnation: input.expected,
          },
        })
        .pipe(Effect.result);
      const whileClaimWaits = input.whileClaimWaits;
      const claimed = whileClaimWaits
        ? yield* Fiber.join(
            yield* lifecycle.withRestoreLock(
              key,
              Effect.gen(function* () {
                const fiber = yield* Effect.forkChild(claim);
                yield* Effect.sleep('20 millis');
                yield* whileClaimWaits({ process, agentSessionId, otherPaneId: other.paneId });
                return fiber;
              }),
            ),
          )
        : yield* claim;
      const database = yield* RuntimeDatabase;
      const placedIn = yield* database.use('test_find_rejoined_pane', (db) =>
        db.select().from(surfacePanes).where(eq(surfacePanes.sessionId, agentSessionId)).get(),
      );
      const focus = yield* repository.findEnvironmentFocus(worktreeId);
      const explicitToken = explicit
        ? yield* lifecycle
            .consumeAttachToken({ key, token: explicit.attachToken })
            .pipe(Effect.result)
        : null;
      const token = Result.isSuccess(claimed)
        ? yield* lifecycle.consumeAttachToken({ key, token: claimed.success.attachToken })
        : null;
      return {
        claimed,
        placedIn: placedIn?.id ?? null,
        rejoiningPaneId: rejoining.paneId,
        otherPaneId: other.paneId,
        focusedPaneId: focus?.activePaneId ?? null,
        token,
        explicitToken,
        moved,
      };
    }).pipe(
      Effect.provide(
        testLayer(dataRoot, {
          agentService: {
            get: (agentSessionId) =>
              Effect.sync(() => ({
                ...agentSessionRowForTest({ id: agentSessionId, worktreeId: 1 }),
                activePtyProcessId: process.id,
                activePtyProcess: ptyProcessRow(process),
              })),
          },
        }),
      ),
      Effect.ensuring(Effect.sync(() => rmSync(dataRoot, { recursive: true, force: true }))),
    ),
  );
}

const refusal = (result: Awaited<ReturnType<typeof rejoinScenario>>) =>
  Result.isFailure(result.claimed) && result.claimed.failure instanceof SurfaceError
    ? result.claimed.failure.code
    : null;

test('an automatic rejoin claim joins the live incarnation it names, in place', async () => {
  const live = await rejoinScenario({
    process: { id: 101, status: 'running' },
    expected: 'pty:101',
  });

  assert.ok(Result.isSuccess(live.claimed));
  assert.equal(live.placedIn, live.rejoiningPaneId);
  assert.equal(live.token?.expectedIncarnation, 'pty:101', 'its attach may join only that process');
  assert.equal(
    live.focusedPaneId,
    live.otherPaneId,
    'the saved focus stays where the user left it',
  );
});

test('an automatic rejoin claim is refused when its projection is stale', async () => {
  // The projection still named `pty:100` after `pty:101` launched and exited.
  const replaced = await rejoinScenario({
    process: { id: 101, status: 'exited' },
    expected: 'pty:100',
  });
  const exited = await rejoinScenario({
    process: { id: 100, status: 'exited' },
    expected: 'pty:100',
  });
  // A newer operation moved the session to another pane.
  const relocated = await rejoinScenario({
    process: { id: 100, status: 'running' },
    expected: 'pty:100',
    elsewhere: true,
  });

  for (const result of [replaced, exited, relocated]) {
    assert.equal(refusal(result), 'process_incarnation_stale');
    assert.equal(result.focusedPaneId, result.otherPaneId);
  }
  assert.equal(relocated.placedIn, relocated.otherPaneId, 'a rejoin never relocates a session');
});

test('an automatic rejoin claim checks its preconditions under the session lock', async () => {
  const result = await rejoinScenario({
    process: { id: 100, status: 'running' },
    expected: 'pty:100',
    // While the claim waits: the process exits and a newer claim moves the session away.
    whileClaimWaits: ({ process, agentSessionId, otherPaneId }) =>
      Effect.gen(function* () {
        process.status = 'exited';
        const repository = yield* SurfaceRepository;
        yield* repository.claimPaneSession({
          paneId: otherPaneId,
          sessionKind: 'agent_session',
          sessionId: agentSessionId,
        });
      }),
  });

  assert.equal(refusal(result), 'process_incarnation_stale');
  assert.equal(result.placedIn, result.otherPaneId, 'the stale claim does not move it back');
});

test('an automatic rejoin claim never takes the process from the attachment streaming it', async () => {
  const held = await rejoinScenario({
    process: { id: 101, status: 'running' },
    expected: 'pty:101',
    holder: 'pty:101',
  });
  assert.equal(refusal(held), 'session_already_attached');
  assert.equal(held.moved, 0, 'the holder keeps its attachment');

  // The pane's own socket to the process it watched exit is only lingering: it gives way.
  const lingering = await rejoinScenario({
    process: { id: 101, status: 'running' },
    expected: 'pty:101',
    holder: 'pty:100',
  });
  assert.ok(Result.isSuccess(lingering.claimed));
  assert.equal(lingering.moved, 1);
});

test('an automatic rejoin claim leaves a pending explicit attach its token', async () => {
  const result = await rejoinScenario({
    process: { id: 101, status: 'running' },
    expected: 'pty:101',
    pendingExplicit: true,
  });

  assert.ok(Result.isSuccess(result.claimed));
  assert.ok(
    result.explicitToken && Result.isSuccess(result.explicitToken),
    'Reconnect still lands',
  );
});

function ptyProcessRow(input: { readonly id: number; readonly status: 'running' | 'exited' }) {
  return {
    id: input.id,
    backend: 'node_pty' as const,
    backendRefJson: '{}',
    command: 'pi',
    args: [],
    argsJson: '[]',
    cwd: '/repo/isagi',
    status: input.status,
    statusReason: null,
    exitCode: input.status === 'exited' ? 0 : null,
    signal: null,
    logMode: 'none' as const,
    logPath: null,
    createdAt: '2026-06-15T00:00:00.000Z',
    updatedAt: '2026-06-15T00:00:00.000Z',
    exitedAt: null,
    lastSeenAt: null,
  };
}

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

test('surface repository lists only pane-bound session bindings', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-pane-session-bindings-'));
  try {
    const bindings = await Effect.runPromise(
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
        const terminalPaneId = yield* addPaneToSurface(surface.surfaceId);
        const terminal = yield* insertPtyProcess({
          paneId: terminalPaneId,
          worktreeId,
          logPath: null,
          status: 'exited',
        });
        yield* insertOrphanTerminalSession(worktreeId);

        const repository = yield* SurfaceRepository;
        const paneSessionBindings = yield* repository.listPaneSessionBindings;
        return { agentSessionId, terminal, paneSessionBindings };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(bindings.paneSessionBindings, [
      {
        paneId: 1,
        sessionKind: 'agent_session',
        sessionId: bindings.agentSessionId,
        activePtyProcessId: null,
      },
      {
        paneId: 2,
        sessionKind: 'terminal_session',
        sessionId: bindings.terminal.terminalSessionId,
        activePtyProcessId: bindings.terminal.ptyProcessId,
      },
    ]);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

function insertOrphanTerminalSession(worktreeId: number) {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    yield* database.use('test_insert_orphan_terminal_session', (db) => {
      const now = new Date().toISOString();
      db.insert(terminalSessions)
        .values({
          worktreeId,
          cwd: '/repo/isagi',
          shellCommand: 'bash',
          shellArgsJson: JSON.stringify([]),
          activePtyProcessId: null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    });
  });
}
