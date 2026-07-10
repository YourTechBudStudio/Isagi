import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Layer } from 'effect';

import type { RuntimeEvent, WorkflowRunSummary } from '@isagi/contracts';

import { DataDirectory, RuntimeDatabase, RuntimeDatabaseLive } from '../persistence/index.js';
import { projects, worktreeSurfaces, worktrees } from '../persistence/schema.js';
import { makeTestDataDirectory } from '../persistence/test-support.js';
import { RuntimeEventBus, RuntimeEventBusLive } from '../runtime-events/event-bus.js';
import {
  InternalRuntimeEventBus,
  InternalRuntimeEventBusLive,
} from '../runtime-events/internal-event-bus.js';
import { WorkflowEventLedgerLive } from './event-ledger.service.js';
import { WorkflowRepository, WorkflowRepositoryLive } from './repository.js';
import {
  WorkflowRunProjection,
  WorkflowRunProjectionLive,
} from './workflow-run-projection.service.js';

// The projection debounces run-change triggers by 75ms and processes them on a forked
// fiber, so tests drive real internal-bus events and wait past the debounce before
// asserting on what reached the public bus.
const SETTLE = '250 millis';
const SURFACE_ID = 1;
const WORKTREE_ID = 1;

test('a touched run publishes one workflow_run_changed and dedupes an identical re-touch', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-projection-changed-'));
  try {
    const result = await Effect.runPromise(
      withProjection((ctx) =>
        Effect.gen(function* () {
          const run = yield* ctx.repository.createRun({
            workflowKey: 'projection-changed',
            workflowTitle: 'Projection Changed',
            workflowArtifactHash: '0'.repeat(64),
            state: { phase: 'a' },
            stateVersion: 1,
            worktreeId: WORKTREE_ID,
            surfaceId: SURFACE_ID,
          });
          // createRun already published one `workflow_run_touched`; let it settle.
          yield* Effect.sleep(SETTLE);
          const afterCreate = ctx.changed().length;

          // An identical re-touch recomputes the same summary, so `publishChanged`
          // suppresses it — the public bus must not see a second frame.
          yield* ctx.internalBus.publish({
            type: 'workflow_run_touched',
            runId: run.id,
            rootRunId: run.id,
            surfaceId: SURFACE_ID,
          });
          yield* Effect.sleep(SETTLE);
          return {
            runId: run.id,
            afterCreate,
            afterRetouch: ctx.changed().length,
            changed: ctx.changed(),
          };
        }),
      ).pipe(Effect.provide(projectionLayer(dataRoot))),
    );

    assert.equal(result.afterCreate, 1, 'creating a run publishes exactly one changed frame');
    assert.equal(result.afterRetouch, 1, 'an identical re-touch is deduped');
    const summary = result.changed[0]?.payload as WorkflowRunSummary;
    assert.equal(summary.runId, result.runId);
    assert.equal(summary.rootRunId, result.runId);
    assert.equal(summary.status, 'ready');
    assert.equal(summary.surfaceId, SURFACE_ID);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('rapid touches for one run coalesce into a single published frame', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-projection-coalesce-'));
  try {
    const result = await Effect.runPromise(
      withProjection((ctx) =>
        Effect.gen(function* () {
          const run = yield* ctx.repository.createRun({
            workflowKey: 'projection-coalesce',
            workflowTitle: 'Projection Coalesce',
            workflowArtifactHash: '0'.repeat(64),
            state: { phase: 'a' },
            stateVersion: 1,
            worktreeId: WORKTREE_ID,
            surfaceId: SURFACE_ID,
          });
          // Fire several extra touches inside the debounce window; they must collapse
          // into the single recompute already scheduled by createRun.
          for (let i = 0; i < 4; i += 1) {
            yield* ctx.internalBus.publish({
              type: 'workflow_run_touched',
              runId: run.id,
              rootRunId: run.id,
              surfaceId: SURFACE_ID,
            });
          }
          yield* Effect.sleep(SETTLE);
          return ctx.changed().length;
        }),
      ).pipe(Effect.provide(projectionLayer(dataRoot))),
    );

    assert.equal(result, 1, 'five triggers within the debounce window coalesce to one frame');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('ui_feedback is projected into the summary and a tree delete clears the run', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-projection-clear-'));
  try {
    const result = await Effect.runPromise(
      withProjection((ctx) =>
        Effect.gen(function* () {
          const run = yield* ctx.repository.createRun({
            workflowKey: 'projection-clear',
            workflowTitle: 'Projection Clear',
            workflowArtifactHash: '0'.repeat(64),
            state: { phase: 'a' },
            stateVersion: 1,
            worktreeId: WORKTREE_ID,
            surfaceId: SURFACE_ID,
          });
          yield* Effect.sleep(SETTLE);

          // ui_feedback is user-visible workflow state, so the event alone must publish
          // a changed summary; it cannot wait for a separate row touch.
          yield* ctx.internalBus.publish({
            type: 'workflow_event_appended',
            surfaceId: SURFACE_ID,
            rootRunId: run.id,
            runId: run.id,
            event: {
              type: 'ui_feedback',
              ts: '2026-06-18T00:00:00.000Z',
              runId: run.id,
              kind: 'info',
              phase: 'working',
              message: 'Halfway there.',
            },
          });
          yield* Effect.sleep(SETTLE);
          const withFeedback = ctx.changed().at(-1)?.payload as WorkflowRunSummary | undefined;

          // Deleting the tree drives a recompute to a null summary, which must clear.
          yield* ctx.repository.deleteRunTree({ rootRunId: run.id, surfaceId: SURFACE_ID });
          yield* Effect.sleep(SETTLE);

          return {
            runId: run.id,
            feedback: withFeedback?.uiFeedback,
            cleared: ctx.cleared(),
          };
        }),
      ).pipe(Effect.provide(projectionLayer(dataRoot))),
    );

    assert.deepEqual(
      result.feedback,
      { kind: 'info', phase: 'working', message: 'Halfway there.' },
      'ui_feedback alone publishes a summary with the latest feedback',
    );
    assert.equal(result.cleared.length, 1, 'a tree delete publishes exactly one cleared frame');
    assert.deepEqual(result.cleared[0]?.payload, {
      runId: result.runId,
      rootRunId: result.runId,
      surfaceId: SURFACE_ID,
    });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('a deleted surface clears the root runs shown on it', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-projection-surface-'));
  try {
    const result = await Effect.runPromise(
      withProjection((ctx) =>
        Effect.gen(function* () {
          const run = yield* ctx.repository.createRun({
            workflowKey: 'projection-surface',
            workflowTitle: 'Projection Surface',
            workflowArtifactHash: '0'.repeat(64),
            state: { phase: 'a' },
            stateVersion: 1,
            worktreeId: WORKTREE_ID,
            surfaceId: SURFACE_ID,
          });
          yield* Effect.sleep(SETTLE);

          yield* ctx.internalBus.publish({
            type: 'surface_changed',
            payload: {
              worktreeId: WORKTREE_ID,
              surfaceId: SURFACE_ID,
              change: 'deleted',
              deletedPaneIds: [],
            },
          });
          yield* Effect.sleep(SETTLE);
          return { runId: run.id, cleared: ctx.cleared() };
        }),
      ).pipe(Effect.provide(projectionLayer(dataRoot))),
    );

    assert.equal(result.cleared.length, 1, 'deleting the surface clears its root run');
    assert.deepEqual(result.cleared[0]?.payload, {
      runId: result.runId,
      rootRunId: result.runId,
      surfaceId: SURFACE_ID,
    });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

interface ProjectionTestContext {
  readonly repository: import('./repository.js').WorkflowRepositoryService;
  readonly internalBus: import('../runtime-events/internal-event-bus.js').InternalRuntimeEventBusService;
  readonly changed: () => Extract<RuntimeEvent, { readonly type: 'workflow_run_changed' }>[];
  readonly cleared: () => Extract<RuntimeEvent, { readonly type: 'workflow_run_cleared' }>[];
}

// Subscribes to the public bus, collects its frames on a background fiber, and hands
// the scenario a small context of the services it needs plus typed views of what the
// projection published.
function withProjection<A>(body: (ctx: ProjectionTestContext) => Effect.Effect<A, unknown, never>) {
  return Effect.gen(function* () {
    const repository = yield* WorkflowRepository;
    const internalBus = yield* InternalRuntimeEventBus;
    const publicBus = yield* RuntimeEventBus;
    // Force the projection layer to build so it is subscribed before the scenario runs.
    yield* WorkflowRunProjection;

    const events: RuntimeEvent[] = [];
    const subscription = yield* publicBus.subscribe;
    yield* Effect.fork(
      Effect.forever(
        subscription.take.pipe(
          Effect.flatMap((event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          ),
        ),
      ),
    );

    return yield* body({
      repository,
      internalBus,
      changed: () =>
        events.filter(
          (event): event is Extract<RuntimeEvent, { readonly type: 'workflow_run_changed' }> =>
            event.type === 'workflow_run_changed',
        ),
      cleared: () =>
        events.filter(
          (event): event is Extract<RuntimeEvent, { readonly type: 'workflow_run_cleared' }> =>
            event.type === 'workflow_run_cleared',
        ),
    });
  });
}

function projectionLayer(dataRoot: string) {
  const dataDirectory = Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot));
  const database = RuntimeDatabaseLive.pipe(Layer.provide(dataDirectory));
  const seed = Layer.scopedDiscard(seedWorkspace).pipe(Layer.provide(database));
  const repository = WorkflowRepositoryLive.pipe(Layer.provide(database));
  const eventLedger = WorkflowEventLedgerLive.pipe(
    Layer.provide(repository),
    Layer.provide(dataDirectory),
  );
  const projection = WorkflowRunProjectionLive.pipe(
    Layer.provide(repository),
    Layer.provide(eventLedger),
  );
  return Layer.mergeAll(projection, repository, eventLedger, database, seed).pipe(
    Layer.provideMerge(InternalRuntimeEventBusLive),
    Layer.provideMerge(RuntimeEventBusLive),
  );
}

const seedWorkspace = Effect.gen(function* () {
  const database = yield* RuntimeDatabase;
  yield* database.use('test_seed_projection_workspace', (db) => {
    const now = '2026-06-18T00:00:00.000Z';
    db.insert(projects)
      .values({
        id: 1,
        name: 'Test Project',
        rootPath: '/tmp/isagi-test-project',
        status: 'present',
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
        missingReason: null,
      })
      .onConflictDoNothing()
      .run();
    db.insert(worktrees)
      .values({
        id: WORKTREE_ID,
        projectId: 1,
        path: '/tmp/isagi-test-worktree',
        branch: 'main',
        head: 'abc123',
        createdAt: now,
        updatedAt: now,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .onConflictDoNothing()
      .run();
    db.insert(worktreeSurfaces)
      .values({
        id: SURFACE_ID,
        worktreeId: WORKTREE_ID,
        title: 'Test Surface',
        layoutJson: JSON.stringify({ kind: 'leaf', nodeId: 'pane-7', paneId: 7, collapsed: false }),
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
  });
});
