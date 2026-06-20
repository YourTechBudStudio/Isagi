import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { Effect, Either, Layer } from 'effect';

import {
  AgentSessionAttentionProjectionLive,
  AgentSessionArtifacts,
  AgentSessionArtifactsLive,
  AgentSessionService,
  type AgentSessionServiceShape,
} from '../agent-sessions/index.js';
import {
  DataDirectory,
  DatabaseError,
  RuntimeDatabase,
  RuntimeDatabaseLive,
  type DataDirectoryService,
} from '../persistence/index.js';
import {
  agentSessions,
  ptyProcesses,
  surfacePanes,
  terminalSessions,
  worktreeSurfaces,
} from '../persistence/schema.js';
import { PtyForegroundStateLive } from '../pty-processes/index.js';
import { InternalRuntimeEventBusLive } from '../runtime-events/index.js';
import { SessionLifecycleLive } from '../session-lifecycle/index.js';
import {
  TerminalSessionService,
  type TerminalSessionServiceShape,
} from '../terminal-sessions/index.js';
import { WorkspaceRepository, WorkspaceRepositoryLive } from '../workspace/index.js';
import {
  SurfaceError,
  SurfaceRepositoryLive,
  SurfaceService,
  SurfaceServiceLive,
} from './index.js';

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

test('split pane creates a sibling terminal pane, updates layout, assigns session, and focuses it', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-split-terminal-'));
  let nextTerminalSessionId = 200;
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
        const database = yield* RuntimeDatabase;
        const newPane = yield* database.use('test_find_split_terminal_pane', (db) =>
          db.select().from(surfacePanes).where(eq(surfacePanes.id, split.paneId)).get(),
        );
        return {
          surface,
          split,
          newPane,
          detail: yield* surfaces.getSurfaceDetail(surface.surfaceId),
        };
      }).pipe(
        Effect.provide(
          testLayer(dataRoot, {
            terminalService: {
              startFresh: () =>
                Effect.sync(() => {
                  nextTerminalSessionId += 1;
                  return { terminalSessionId: nextTerminalSessionId };
                }),
            },
          }),
        ),
      ),
    );

    assert.deepEqual(output.split, {
      worktreeId: output.surface.worktreeId,
      surfaceId: output.surface.surfaceId,
      paneId: output.split.paneId,
      title: 'Terminal 2',
    });
    assert.equal(output.newPane?.sessionKind, 'terminal_session');
    assert.equal(output.newPane?.sessionId, 202);
    assert.equal(output.detail.activePaneId, output.split.paneId);
    assert.equal(output.detail.panes.length, 2);
    assert.deepEqual(output.detail.layout, {
      kind: 'split',
      nodeId: `split-${output.split.paneId}`,
      axis: 'row',
      sizing: 'manual',
      children: [
        {
          kind: 'leaf',
          nodeId: `pane-${output.surface.paneId}`,
          paneId: output.surface.paneId,
          collapsed: false,
        },
        {
          kind: 'leaf',
          nodeId: `pane-${output.split.paneId}`,
          paneId: output.split.paneId,
          collapsed: false,
        },
      ],
      weights: [0.5, 0.5],
    });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('failed split session creation leaves the split pane recoverable and sessionless', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-split-agent-failed-'));
  let startCount = 0;
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const surface = yield* surfaces.createSurface({
          worktreeId,
          initialPane: { kind: 'agent_session', harness: 'pi' },
        });
        const result = yield* surfaces
          .splitPane({
            worktreeId,
            split: {
              paneId: surface.paneId,
              direction: 'down',
              newPane: { kind: 'agent_session', harness: 'pi' },
            },
          })
          .pipe(Effect.either);
        const detail = yield* surfaces.getSurfaceDetail(surface.surfaceId);
        return { surface, result, detail };
      }).pipe(
        Effect.provide(
          testLayer(dataRoot, {
            agentService: {
              startFresh: () =>
                Effect.gen(function* () {
                  startCount += 1;
                  if (startCount === 1) return { agentSessionId: 900 };
                  return yield* Effect.fail(
                    new DatabaseError({
                      operation: 'test_split_agent_start_fresh',
                      cause: new Error('agent split creation failed'),
                    }),
                  );
                }),
            },
          }),
        ),
      ),
    );

    assert.ok(Either.isLeft(output.result));
    assert.equal(output.detail.panes.length, 2);
    const splitPane = output.detail.panes.find((pane) => pane.id !== output.surface.paneId);
    assert.ok(splitPane);
    assert.equal(splitPane.title, 'Pi 2');
    assert.equal(splitPane.session, null);
    assert.deepEqual(output.detail.layout, {
      kind: 'split',
      nodeId: `split-${splitPane.id}`,
      axis: 'column',
      sizing: 'manual',
      children: [
        {
          kind: 'leaf',
          nodeId: `pane-${output.surface.paneId}`,
          paneId: output.surface.paneId,
          collapsed: false,
        },
        {
          kind: 'leaf',
          nodeId: `pane-${splitPane.id}`,
          paneId: splitPane.id,
          collapsed: false,
        },
      ],
      weights: [0.5, 0.5],
    });
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

test('environment focus persists active pane only when it belongs to the active surface', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-focus-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const first = yield* surfaces.createSinglePaneSurface({
          worktreeId,

          titleBase: 'Terminal',
        });
        const second = yield* surfaces.createSinglePaneSurface({
          worktreeId,

          titleBase: 'Terminal',
        });

        yield* surfaces.setWorktreeEnvironmentFocus({
          worktreeId,
          focus: { activeSurfaceId: first.surfaceId, activePaneId: first.paneId },
        });

        return {
          firstDetail: yield* surfaces.getSurfaceDetail(first.surfaceId),
          secondDetail: yield* surfaces.getSurfaceDetail(second.surfaceId),
        };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(output.firstDetail.activePaneId, output.firstDetail.panes[0]?.id);
    assert.equal(output.secondDetail.activePaneId, null);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('environment focus rejects panes that do not belong to the selected surface', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-invalid-focus-'));
  try {
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          const worktreeId = yield* insertWorktree('/repo/isagi');
          const surfaces = yield* SurfaceService;
          const first = yield* surfaces.createSinglePaneSurface({
            worktreeId,

            titleBase: 'Terminal',
          });
          const second = yield* surfaces.createSinglePaneSurface({
            worktreeId,

            titleBase: 'Terminal',
          });

          return yield* surfaces.setWorktreeEnvironmentFocus({
            worktreeId,
            focus: { activeSurfaceId: first.surfaceId, activePaneId: second.paneId },
          });
        }).pipe(Effect.provide(testLayer(dataRoot))),
      ),
    );

    assert.ok(error instanceof SurfaceError);
    assert.equal(error.code, 'pane_not_found');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('rename trims surface title, allows duplicates, and leaves pane title unchanged', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-rename-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const first = yield* surfaces.createSinglePaneSurface({
          worktreeId,

          titleBase: 'Terminal',
        });
        yield* surfaces.createSinglePaneSurface({
          worktreeId,

          titleBase: 'Terminal',
        });

        const renamed = yield* surfaces.renameSurface({
          surfaceId: first.surfaceId,
          title: '  Terminal 2  ',
        });
        return {
          renamed,
          detail: yield* surfaces.getSurfaceDetail(first.surfaceId),
        };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(output.renamed, {
      surfaceId: output.detail.id,
      title: 'Terminal 2',
    });
    assert.equal(output.detail.title, 'Terminal 2');
    assert.equal(output.detail.panes[0]?.title, 'Terminal');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('rename rejects empty and overlong titles', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-rename-invalid-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const surface = yield* surfaces.createSinglePaneSurface({
          worktreeId,

          titleBase: 'Terminal',
        });
        const empty = yield* surfaces
          .renameSurface({ surfaceId: surface.surfaceId, title: '   ' })
          .pipe(Effect.either);
        const long = yield* surfaces
          .renameSurface({ surfaceId: surface.surfaceId, title: 'a'.repeat(81) })
          .pipe(Effect.either);
        return { empty, long };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(Either.isLeft(output.empty), true);
    assert.equal(Either.isLeft(output.long), true);
    if (Either.isLeft(output.empty)) {
      assert.ok(output.empty.left instanceof SurfaceError);
      assert.equal(output.empty.left.code, 'invalid_surface_title');
    }
    if (Either.isLeft(output.long)) {
      assert.ok(output.long.left instanceof SurfaceError);
      assert.equal(output.long.left.code, 'invalid_surface_title');
    }
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('delete pane updates layout and keeps the remaining pane', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-delete-pane-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const first = yield* surfaces.createSinglePaneSurface({
          worktreeId,

          titleBase: 'Terminal',
        });
        const secondPaneId = yield* addPaneToSurface(first.surfaceId);

        const deleted = yield* surfaces.deleteSurfacePane({
          surfaceId: first.surfaceId,
          paneId: first.paneId,
        });
        return {
          first,
          deleted,
          detail: yield* surfaces.getSurfaceDetail(first.surfaceId),
          secondPaneId,
        };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(output.deleted, {
      deletedSurfaceId: null,
      deletedPaneIds: [output.first.paneId],
    });
    assert.equal(output.deleted.deletedPaneIds.length, 1);
    assert.equal(output.detail.panes.length, 1);
    assert.equal(output.detail.panes[0]?.id, output.secondPaneId);
    assert.deepEqual(output.detail.layout, {
      kind: 'leaf',
      nodeId: `pane-${output.secondPaneId}`,
      paneId: output.secondPaneId,
      collapsed: false,
    });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('delete last pane deletes the surface and leaves referenced logs for PTY GC', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-delete-last-pane-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const surface = yield* surfaces.createSinglePaneSurface({
          worktreeId,

          titleBase: 'Terminal',
        });
        mkdirSync(join(dataRoot, 'sessions'), { recursive: true });
        const logPath = join(dataRoot, 'sessions', 'delete-last-pane.ptylog');
        writeFileSync(logPath, 'session log', 'utf8');
        yield* insertPtyProcess({
          paneId: surface.paneId,
          worktreeId,
          logPath,
          status: 'exited',
        });

        const deleted = yield* surfaces.deleteSurfacePane({
          surfaceId: surface.surfaceId,
          paneId: surface.paneId,
        });
        const detail = yield* surfaces.getSurfaceDetail(surface.surfaceId).pipe(Effect.either);
        return { deleted, detail, logPath, surface };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(output.deleted, {
      deletedSurfaceId: output.surface.surfaceId,
      deletedPaneIds: [output.surface.paneId],
    });
    assert.equal(existsSync(output.logPath), true);
    assert.equal(Either.isLeft(output.detail), true);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('delete surface leaves log cleanup failures to PTY GC', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-delete-log-warning-'));
  const warnings: unknown[] = [];
  const originalConsoleWarn = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(message);
  };

  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const surface = yield* surfaces.createSinglePaneSurface({
          worktreeId,

          titleBase: 'Terminal',
        });
        mkdirSync(join(dataRoot, 'sessions'), { recursive: true });
        const logPath = join(dataRoot, 'sessions', 'log-path-is-directory.ptylog');
        mkdirSync(logPath);
        yield* insertPtyProcess({
          paneId: surface.paneId,
          worktreeId,
          logPath,
          status: 'exited',
        });

        const deleted = yield* surfaces.deleteSurface(surface.surfaceId);
        const detail = yield* surfaces.getSurfaceDetail(surface.surfaceId).pipe(Effect.either);
        return { deleted, detail, logPath, surface };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(output.deleted, {
      deletedSurfaceId: output.surface.surfaceId,
      deletedPaneIds: [output.surface.paneId],
    });
    assert.equal(existsSync(output.logPath), true);
    assert.equal(Either.isLeft(output.detail), true);
    assert.equal(warnings.length, 0);
  } finally {
    console.warn = originalConsoleWarn;
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('delete surface leaves live PTY cleanup to PTY GC', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-delete-warning-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const surface = yield* surfaces.createSinglePaneSurface({
          worktreeId,

          titleBase: 'Terminal',
        });
        yield* insertPtyProcess({
          paneId: surface.paneId,
          worktreeId,
          logPath: null,
          status: 'running',
        });

        const deleted = yield* surfaces.deleteSurface(surface.surfaceId);
        const detail = yield* surfaces.getSurfaceDetail(surface.surfaceId).pipe(Effect.either);
        return { deleted, detail, surface };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(output.deleted.deletedSurfaceId, output.surface.surfaceId);
    assert.deepEqual(output.deleted.deletedPaneIds, [output.surface.paneId]);
    assert.equal(Either.isLeft(output.detail), true);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('delete pane defers every live session when invalid layout escalates to surface delete', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-delete-pane-invalid-layout-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const surface = yield* surfaces.createSinglePaneSurface({
          worktreeId,

          titleBase: 'Terminal',
        });
        const secondPaneId = yield* addPaneToSurface(surface.surfaceId);
        yield* insertPtyProcess({
          paneId: surface.paneId,
          worktreeId,
          logPath: null,
          status: 'running',
        });
        yield* insertPtyProcess({
          paneId: secondPaneId,
          worktreeId,
          logPath: null,
          status: 'running',
        });
        yield* replaceSurfaceLayoutWithSingleDeletedPane(surface.surfaceId, surface.paneId);

        const deleted = yield* surfaces.deleteSurfacePane({
          surfaceId: surface.surfaceId,
          paneId: surface.paneId,
        });
        const detail = yield* surfaces.getSurfaceDetail(surface.surfaceId).pipe(Effect.either);
        return { deleted, detail, surface, secondPaneId };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(output.deleted, {
      deletedSurfaceId: output.surface.surfaceId,
      deletedPaneIds: [output.surface.paneId, output.secondPaneId],
    });
    assert.equal(Either.isLeft(output.detail), true);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

function insertWorktree(rootPath: string) {
  return Effect.gen(function* () {
    const workspaceRepository = yield* WorkspaceRepository;
    const projectId = yield* workspaceRepository.insertProject({ name: 'isagi', rootPath });
    yield* workspaceRepository.reconcileProjectWorktrees({
      projectId,
      discovered: [{ path: rootPath, branch: 'main', head: 'abcdef0' }],
    });
    const worktrees = yield* workspaceRepository.listWorktrees;
    const worktree = worktrees.find((candidate) => candidate.projectId === projectId);
    if (!worktree) {
      return yield* Effect.die('Expected test worktree to be inserted.');
    }
    return worktree.id;
  });
}

function replaceSurfaceLayoutWithSingleDeletedPane(surfaceId: number, paneId: number) {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    return yield* database.use('test_replace_surface_layout_with_single_deleted_pane', (db) => {
      db.update(worktreeSurfaces)
        .set({
          layoutJson: JSON.stringify({
            kind: 'leaf',
            nodeId: `pane-${paneId}`,
            paneId,
            collapsed: false,
          }),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(worktreeSurfaces.id, surfaceId))
        .run();
    });
  });
}

function addPaneToSurface(surfaceId: number) {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    return yield* database.use('test_add_surface_pane', (db) => {
      const now = new Date().toISOString();
      const pane = db
        .insert(surfacePanes)
        .values({
          surfaceId,
          title: 'Second pane',
          sortOrder: 1,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: surfacePanes.id })
        .get();
      const surface = db
        .select({ layoutJson: worktreeSurfaces.layoutJson })
        .from(worktreeSurfaces)
        .where(eq(worktreeSurfaces.id, surfaceId))
        .get();
      if (!surface) {
        throw new Error(`Missing test surface ${surfaceId}.`);
      }
      const existingLayout = JSON.parse(surface.layoutJson);
      db.update(worktreeSurfaces)
        .set({
          layoutJson: JSON.stringify({
            kind: 'split',
            nodeId: `split-${surfaceId}`,
            axis: 'row',
            sizing: 'manual',
            children: [
              existingLayout,
              {
                kind: 'leaf',
                nodeId: `pane-${pane.id}`,
                paneId: pane.id,
                collapsed: false,
              },
            ],
            weights: [0.4, 0.6],
          }),
          updatedAt: now,
        })
        .where(eq(worktreeSurfaces.id, surfaceId))
        .run();
      return pane.id;
    });
  });
}

function insertAgentSessionForWorktree(input: {
  readonly worktreeId: number;
  readonly paneId: number;
}) {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    const artifacts = yield* AgentSessionArtifacts;
    const sessionId = yield* database.use('test_insert_agent_session_for_pane', (db) => {
      const now = new Date().toISOString();
      const session = db
        .insert(agentSessions)
        .values({
          worktreeId: input.worktreeId,
          harness: 'pi',
          cwd: '/repo/isagi',
          activePtyProcessId: null,
          createdAt: now,
          updatedAt: now,
          lastSeenAt: null,
        })
        .returning({ id: agentSessions.id })
        .get();
      db.update(surfacePanes)
        .set({ sessionKind: 'agent_session', sessionId: session.id, updatedAt: now })
        .where(eq(surfacePanes.id, input.paneId))
        .run();
      return session.id;
    });
    yield* artifacts.initializeMetadata(sessionId);
    return sessionId;
  });
}

function insertPtyProcess(input: {
  readonly paneId: number;
  readonly worktreeId: number;
  readonly logPath: string | null;
  readonly status: 'starting' | 'running' | 'exited' | 'failed' | 'killed';
}) {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    return yield* database.use('test_insert_pty_process_terminal_session', (db) => {
      const now = new Date().toISOString();
      const process = db
        .insert(ptyProcesses)
        .values({
          backend: 'node_pty',
          backendRefJson: JSON.stringify({
            schemaVersion: 1,
            backend: 'node_pty',
            ptyProcessId: 0,
            pid: null,
          }),
          command: 'bash',
          argsJson: JSON.stringify([]),
          cwd: '/repo/isagi',
          status: input.status,
          statusReason: null,
          exitCode: input.status === 'exited' ? 0 : null,
          signal: null,
          logMode: input.logPath ? 'backend_file' : 'none',
          logPath: input.logPath,
          createdAt: now,
          updatedAt: now,
          exitedAt:
            input.status === 'exited' || input.status === 'failed' || input.status === 'killed'
              ? now
              : null,
          lastSeenAt: null,
        })
        .returning({ id: ptyProcesses.id })
        .get();
      db.update(ptyProcesses)
        .set({
          backendRefJson: JSON.stringify({
            schemaVersion: 1,
            backend: 'node_pty',
            ptyProcessId: process.id,
            pid: null,
          }),
        })
        .where(eq(ptyProcesses.id, process.id))
        .run();
      const session = db
        .insert(terminalSessions)
        .values({
          worktreeId: input.worktreeId,
          cwd: '/repo/isagi',
          shellCommand: 'bash',
          shellArgsJson: JSON.stringify([]),
          activePtyProcessId: process.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: terminalSessions.id })
        .get();
      db.update(surfacePanes)
        .set({ sessionKind: 'terminal_session', sessionId: session.id, updatedAt: now })
        .where(eq(surfacePanes.id, input.paneId))
        .run();
      return session.id;
    });
  });
}

function testLayer(
  dataRoot: string,
  options: {
    readonly agentService?: Partial<AgentSessionServiceShape> | undefined;
    readonly terminalService?: Partial<TerminalSessionServiceShape> | undefined;
  } = {},
) {
  const dataDirectory = {
    paths: {
      root: dataRoot,
      databasePath: join(dataRoot, 'isagi.db'),
      statePath: join(dataRoot, 'state.json'),
      worktreesPath: join(dataRoot, 'worktrees'),
      sessionsPath: join(dataRoot, 'sessions'),
    },
  } satisfies DataDirectoryService;

  const dataDirectoryLayer = Layer.succeed(DataDirectory, dataDirectory);
  const internalRuntimeEventBus = InternalRuntimeEventBusLive;
  const agentSessionArtifacts = AgentSessionArtifactsLive.pipe(Layer.provide(dataDirectoryLayer));
  const database = RuntimeDatabaseLive.pipe(Layer.provide(dataDirectoryLayer));
  const attentionProjection = AgentSessionAttentionProjectionLive.pipe(
    Layer.provide(dataDirectoryLayer),
    Layer.provide(database),
    Layer.provide(agentSessionArtifacts),
    Layer.provide(PtyForegroundStateLive),
    Layer.provide(internalRuntimeEventBus),
  );
  const workspaceRepository = WorkspaceRepositoryLive.pipe(Layer.provide(database));
  const agentService = Layer.succeed(
    AgentSessionService,
    fakeAgentSessionService(options.agentService),
  );
  const terminalService = Layer.succeed(
    TerminalSessionService,
    fakeTerminalSessionService(options.terminalService),
  );
  const surfaceRepository = SurfaceRepositoryLive.pipe(
    Layer.provide(database),
    Layer.provide(agentSessionArtifacts),
    Layer.provide(attentionProjection),
  );
  const sessionLifecycle = SessionLifecycleLive;
  const surfaceService = SurfaceServiceLive.pipe(
    Layer.provide(surfaceRepository),
    Layer.provide(agentService),
    Layer.provide(terminalService),
    Layer.provide(sessionLifecycle),
    Layer.provide(internalRuntimeEventBus),
  );
  return Layer.mergeAll(
    database,
    agentSessionArtifacts,
    attentionProjection,
    internalRuntimeEventBus,
    workspaceRepository,
    surfaceRepository,
    surfaceService,
    sessionLifecycle,
  );
}

function fakeAgentSessionService(
  overrides: Partial<AgentSessionServiceShape> = {},
): AgentSessionServiceShape {
  return {
    startFresh: () => Effect.die('agent startFresh is not used by surface service tests'),
    get: () => Effect.die('agent get is not used by surface service tests'),
    ensureActivePtyProcess: () =>
      Effect.die('agent ensureActivePtyProcess is not used by surface service tests'),
    activePtyProcessId: () =>
      Effect.die('agent activePtyProcessId is not used by surface service tests'),
    ...overrides,
  } satisfies AgentSessionServiceShape;
}

function fakeTerminalSessionService(
  overrides: Partial<TerminalSessionServiceShape> = {},
): TerminalSessionServiceShape {
  return {
    startFresh: () => Effect.die('terminal startFresh is not used by surface service tests'),
    get: () => Effect.die('terminal get is not used by surface service tests'),
    ensureActivePtyProcess: () =>
      Effect.die('terminal ensureActivePtyProcess is not used by surface service tests'),
    activePtyProcessId: () =>
      Effect.die('terminal activePtyProcessId is not used by surface service tests'),
    ...overrides,
  } satisfies TerminalSessionServiceShape;
}

function agentSessionRowForTest(input: { readonly id: number; readonly worktreeId: number }) {
  return {
    id: input.id,
    worktreeId: input.worktreeId,
    harness: 'pi' as const,
    cwd: '/repo/isagi',
    harnessSessionId: null,
    harnessMetadataStatus: 'valid' as const,
    harnessMetadataDiagnostic: null,
    activePtyProcessId: null,
    createdAt: '2026-06-15T00:00:00.000Z',
    updatedAt: '2026-06-15T00:00:00.000Z',
    lastSeenAt: null,
    activePtyProcess: null,
  };
}
