import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { Effect, Either } from 'effect';

import { type AgentSessionServiceShape } from '../../agent-sessions/index.js';
import { DatabaseError, RuntimeDatabase } from '../../persistence/index.js';
import { surfacePanes, worktreeSurfaces } from '../../persistence/schema.js';
import { type TerminalSessionServiceShape } from '../../terminal-sessions/index.js';
import { SurfaceService } from '../index.js';
import { insertWorktree, testLayer } from './test-support.js';

test('single-pane surface creation persists duplicate-safe titles and one-leaf layout', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-data-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const first = yield* surfaces.createSinglePaneSurface({
          worktreeId,

          titleBase: 'Pi',
        });
        const second = yield* surfaces.createSinglePaneSurface({
          worktreeId,

          titleBase: 'Pi',
        });
        return {
          first,
          second,
          detail: yield* surfaces.getSurfaceDetail(first.surfaceId),
        };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(output.first.title, 'Pi');
    assert.equal(output.second.title, 'Pi 2');
    assert.deepEqual(output.detail.layout, {
      kind: 'leaf',
      nodeId: `pane-${output.first.paneId}`,
      paneId: output.first.paneId,
      collapsed: false,
    });
    assert.equal(output.detail.panes[0]?.id, output.first.paneId);
    assert.equal(output.detail.panes[0]?.session, null);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('create surface API slice creates and focuses an initial terminal session', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-create-api-'));
  let startFreshInput: Parameters<TerminalSessionServiceShape['startFresh']>[0] | null = null;
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const created = yield* surfaces.createSurface({
          worktreeId,
          initialPane: { kind: 'terminal_session' },
        });
        const database = yield* RuntimeDatabase;
        const pane = yield* database.use('test_find_created_terminal_pane', (db) =>
          db.select().from(surfacePanes).where(eq(surfacePanes.id, created.paneId)).get(),
        );
        return {
          created,
          pane,
          focus: yield* surfaces.setWorktreeEnvironmentFocus({
            worktreeId,
            focus: { activeSurfaceId: created.surfaceId, activePaneId: created.paneId },
          }),
          detail: yield* surfaces.getSurfaceDetail(created.surfaceId),
        };
      }).pipe(
        Effect.provide(
          testLayer(dataRoot, {
            terminalService: {
              startFresh: (input) =>
                Effect.sync(() => {
                  startFreshInput = input;
                  return { terminalSessionId: 123 };
                }),
            },
          }),
        ),
      ),
    );

    assert.equal(output.created.title, 'Terminal');
    assert.deepEqual(startFreshInput, {
      worktreeId: output.created.worktreeId,
      cwd: '/repo/isagi',
    });
    assert.equal(output.pane?.sessionKind, 'terminal_session');
    assert.equal(output.pane?.sessionId, 123);
    assert.equal(output.detail.panes[0]?.id, output.created.paneId);
    assert.equal(output.detail.panes[0]?.session, null);
    assert.deepEqual(output.focus, {
      worktreeId: output.created.worktreeId,
      activeSurfaceId: output.created.surfaceId,
      activePaneId: output.created.paneId,
    });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('create surface uses harness display names with duplicate-safe titles', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-launch-agent-'));
  const startFreshInputs: Parameters<AgentSessionServiceShape['startFresh']>[0][] = [];
  let nextAgentSessionId = 900;
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const first = yield* surfaces.createSurface({
          worktreeId,
          initialPane: { kind: 'agent_session', harness: 'pi' },
        });
        const second = yield* surfaces.createSurface({
          worktreeId,
          initialPane: { kind: 'agent_session', harness: 'pi' },
        });
        const third = yield* surfaces.createSurface({
          worktreeId,
          initialPane: { kind: 'agent_session', harness: 'opencode' },
        });
        const database = yield* RuntimeDatabase;
        const panes = yield* database.use('test_find_launched_agent_panes', (db) =>
          db.select().from(surfacePanes).where(eq(surfacePanes.sessionKind, 'agent_session')).all(),
        );
        return { first, second, third, panes };
      }).pipe(
        Effect.provide(
          testLayer(dataRoot, {
            agentService: {
              startFresh: (input) =>
                Effect.sync(() => {
                  startFreshInputs.push(input);
                  nextAgentSessionId += 1;
                  return { agentSessionId: nextAgentSessionId };
                }),
            },
          }),
        ),
      ),
    );

    assert.deepEqual(
      [output.first.title, output.second.title, output.third.title],
      ['Pi', 'Pi 2', 'OpenCode'],
    );
    assert.deepEqual(
      startFreshInputs.map((input) => input.harness),
      ['pi', 'pi', 'opencode'],
    );
    assert.equal(output.panes.length, 3);
    assert.deepEqual(
      output.panes.map((pane) => pane.sessionId),
      [901, 902, 903],
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('failed agent surface creation leaves the harness-titled empty surface visible', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-launch-agent-failed-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const result = yield* surfaces
          .createSurface({ worktreeId, initialPane: { kind: 'agent_session', harness: 'pi' } })
          .pipe(Effect.either);
        const database = yield* RuntimeDatabase;
        const persistedSurface = yield* database.use('test_find_failed_launch_surface', (db) =>
          db
            .select()
            .from(worktreeSurfaces)
            .where(eq(worktreeSurfaces.worktreeId, worktreeId))
            .get(),
        );
        assert.ok(persistedSurface);
        return {
          result,
          detail: yield* surfaces.getSurfaceDetail(persistedSurface.id),
        };
      }).pipe(
        Effect.provide(
          testLayer(dataRoot, {
            agentService: {
              startFresh: () =>
                Effect.fail(
                  new DatabaseError({
                    operation: 'test_agent_start_fresh',
                    cause: new Error('agent session creation failed'),
                  }),
                ),
            },
          }),
        ),
      ),
    );

    assert.ok(Either.isLeft(output.result));
    assert.equal(output.detail.title, 'Pi');
    assert.equal(output.detail.panes.length, 1);
    assert.equal(output.detail.panes[0]?.title, 'Pi');
    assert.equal(output.detail.panes[0]?.session, null);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
