import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { Effect, Either } from 'effect';

import { DatabaseError, RuntimeDatabase } from '../../persistence/index.js';
import { surfacePanes } from '../../persistence/schema.js';
import { SurfaceError, SurfaceService } from '../index.js';
import { addPaneToSurface, insertWorktree, testLayer } from './test-support.js';

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

test('set split weights persists normalized manual layout weights', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-set-split-weights-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const surface = yield* surfaces.createSinglePaneSurface({
          worktreeId,
          titleBase: 'Terminal',
        });
        const paneId = yield* addPaneToSurface(surface.surfaceId);
        const updated = yield* surfaces.setSplitWeights({
          surfaceId: surface.surfaceId,
          weights: { nodeId: `split-${surface.surfaceId}`, weights: [2, 1] },
        });
        const detail = yield* surfaces.getSurfaceDetail(surface.surfaceId);
        return { surface, paneId, updated, detail };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(output.updated.layout, {
      kind: 'split',
      nodeId: `split-${output.surface.surfaceId}`,
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
          nodeId: `pane-${output.paneId}`,
          paneId: output.paneId,
          collapsed: false,
        },
      ],
      weights: [0.666667, 0.333333],
    });
    assert.deepEqual(output.detail.layout, output.updated.layout);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('set split weights rejects stale layout nodes and changed child shapes', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-stale-split-weights-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const surface = yield* surfaces.createSinglePaneSurface({
          worktreeId,
          titleBase: 'Terminal',
        });
        yield* addPaneToSurface(surface.surfaceId);
        const missing = yield* surfaces
          .setSplitWeights({
            surfaceId: surface.surfaceId,
            weights: { nodeId: 'split-missing', weights: [0.5, 0.5] },
          })
          .pipe(Effect.either);
        const changedShape = yield* surfaces
          .setSplitWeights({
            surfaceId: surface.surfaceId,
            weights: { nodeId: `split-${surface.surfaceId}`, weights: [0.2, 0.3, 0.5] },
          })
          .pipe(Effect.either);
        return { missing, changedShape };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.ok(Either.isLeft(output.missing));
    assert.ok(output.missing.left instanceof SurfaceError);
    assert.equal(output.missing.left.code, 'layout_node_stale');
    assert.ok(Either.isLeft(output.changedShape));
    assert.ok(output.changedShape.left instanceof SurfaceError);
    assert.equal(output.changedShape.left.code, 'layout_node_stale');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
