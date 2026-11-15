import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import test from 'node:test';

import {
  complete,
  createGraph,
  defineWorkflow,
  edge,
  operation,
  outcome,
  reduce,
  suspend,
  wait,
} from '@yourtechbudstudio/isagi-workflow-sdk';
import { eq } from 'drizzle-orm';
import { Effect, Layer, ManagedRuntime } from 'effect';

import { EnvironmentDeletionParticipant, SurfaceService } from '../environment/index.js';
import { testLayer } from '../environment/testing.js';
import { InternalEvents, RuntimeEvents } from '../platform/events/index.js';
import { RuntimeDatabase } from '../platform/persistence/index.js';
import { ProjectRepository } from '../projects/index.js';
import { withEngine, type EngineHarness } from './engine/test-support.js';
import { WorkflowEnvironmentDeletionNoDeps } from './environment-deletion.js';
import { WorkflowEngineError } from './errors.js';
import type { AnyWorkflowDefinition } from './structure/loader.js';
import { workflowEvents, workflowExecutions, workflowOperations, workflowRuns } from './tables.js';

/**
 * Deleting a surface or worktree ends the workflow runs living there (ADR 0008): the real engine
 * and the real surfaces over one database and one internal event bus, with the real participant
 * wired into the surfaces as the composition root wires it.
 */

/** The real participant; the bus it announces on comes from the surfaces' harness. */
const participantLayer = WorkflowEnvironmentDeletionNoDeps.pipe(Layer.provide(RuntimeEvents.layer));

const runRow = (h: EngineHarness, runId: number) =>
  h.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get()!;

/** One operation node, then success. */
function oneNode(key: string, run: Parameters<typeof operation>[0]): AnyWorkflowDefinition {
  return defineWorkflow({
    command: () => ({ title: key }),
    parse: (_origin, inputs) => inputs,
    graph: createGraph<{ n: number }>({
      key,
      title: key,
      init: () => ({ n: 0 }),
      state: { n: reduce.replace<number>() } as never,
      entry: 'work',
      nodes: { work: operation(run) },
      edges: { out: edge({ from: 'work', to: ['done'], choose: () => ({ to: 'done' }) }) },
      outcomes: { done: outcome({ kind: 'success', output: () => null }) },
    }) as never,
  }) as unknown as AnyWorkflowDefinition;
}

const agentWait = oneNode('agent-wait', async (ctx) => {
  const handle = await ctx.spawnAgentSession({ harness: 'claude', prompt: 'Write.' });
  return suspend({ wait: wait.agentTurn(handle) });
});
const headlessWait = oneNode('headless-wait', async (ctx) => {
  const job = await ctx.runHeadlessAgent({ harness: 'codex', prompt: 'Check.' });
  return suspend({ wait: wait.headlessAgent(job) });
});
const immediate = oneNode('immediate', async () => complete());

/** The real surfaces over the engine harness's database and bus, on its worktree 1. */
async function withSurfaces(
  h: EngineHarness,
  body: (world: {
    readonly run: <A, E>(
      effect: Effect.Effect<A, E, SurfaceService | ProjectRepository | RuntimeDatabase>,
    ) => Promise<A>;
    /** A new surface, also known to the engine's places so a launch may attach to it. */
    readonly createSurface: () => Promise<number>;
    readonly launchOn: (workflowKey: string, surfaceId: number) => Promise<number>;
  }) => Promise<void>,
) {
  const runtime = ManagedRuntime.make(
    testLayer(dirname(h.worktreePath), {
      deletionParticipant: participantLayer,
      internalEvents: h.internalEvents,
    }),
  );
  const run = <A, E>(
    effect: Effect.Effect<A, E, SurfaceService | ProjectRepository | RuntimeDatabase>,
  ) => runtime.runPromise(effect);
  try {
    await body({
      run,
      createSurface: async () => {
        const { surfaceId } = await run(
          SurfaceService.use((surfaces) =>
            surfaces.createSinglePaneSurface({ worktreeId: 1, titleBase: 'Workflow' }),
          ),
        );
        h.places.surfaces.set(surfaceId, { id: surfaceId, worktreeId: 1, title: 'Workflow' });
        return surfaceId;
      },
      launchOn: async (workflowKey, surfaceId) =>
        (
          await h.run(
            h.engine.launch({ workflowKey, inputs: {}, origin: { worktreeId: 1, surfaceId } }),
          )
        ).runId,
    });
  } finally {
    await runtime.dispose();
  }
}

test('deleting a surface cancels the run waiting on an agent there, with the reason', async () => {
  await withEngine(async (h) => {
    h.registry.publish('agent-wait', agentWait);
    await withSurfaces(h, async ({ run, createSurface, launchOn }) => {
      const surfaceId = await createSurface();
      const runId = await launchOn('agent-wait', surfaceId);
      assert.equal(runRow(h, runId).status, 'waiting');

      await run(SurfaceService.use((surfaces) => surfaces.deleteSurface(surfaceId)));
      await h.settle();

      const after = runRow(h, runId);
      assert.equal(after.status, 'cancelled');
      assert.notEqual(after.endedAt, null);
      assert.equal(after.surfaceId, null);
      assert.deepEqual(
        h.db
          .select()
          .from(workflowExecutions)
          .where(eq(workflowExecutions.runId, runId))
          .all()
          .map((execution) => execution.status),
        ['cancelled'],
      );
      const cancelled = h.db
        .select()
        .from(workflowEvents)
        .where(eq(workflowEvents.runId, runId))
        .all()
        .find((event) => event.kind === 'run_cancelled');
      assert.equal(cancelled?.message, 'Cancelled: its surface was deleted');
      assert.deepEqual(JSON.parse(cancelled?.dataJson ?? 'null'), { reason: 'surface_deleted' });
    });
  });
});

test("deleting a surface stops its run's headless job", async () => {
  await withEngine(async (h) => {
    h.registry.publish('headless-wait', headlessWait);
    await withSurfaces(h, async ({ run, createSurface, launchOn }) => {
      const surfaceId = await createSurface();
      const runId = await launchOn('headless-wait', surfaceId);
      assert.equal(h.headless.started.length, 1);

      await run(SurfaceService.use((surfaces) => surfaces.deleteSurface(surfaceId)));
      await h.settle();

      assert.equal(runRow(h, runId).status, 'cancelled');
      assert.deepEqual(
        h.db
          .select()
          .from(workflowOperations)
          .where(eq(workflowOperations.runId, runId))
          .all()
          .map((op) => `${op.kind}:${op.status}`),
        ['run_headless:interrupted'],
      );
      assert.deepEqual(h.headless.terminated, [1]);
    });
  });
});

test('deleting a surface leaves a finished run as it ended, only detached', async () => {
  await withEngine(async (h) => {
    h.registry.publish('immediate', immediate);
    await withSurfaces(h, async ({ run, createSurface, launchOn }) => {
      const surfaceId = await createSurface();
      const runId = await launchOn('immediate', surfaceId);
      const before = runRow(h, runId);
      assert.equal(before.status, 'completed');

      await run(SurfaceService.use((surfaces) => surfaces.deleteSurface(surfaceId)));
      await h.settle();

      const after = runRow(h, runId);
      assert.equal(after.status, 'completed');
      assert.equal(after.endedAt, before.endedAt);
      assert.equal(after.surfaceId, null);
    });
  });
});

test('deleting a worktree cancels its runs and stops their headless jobs', async () => {
  await withEngine(async (h) => {
    h.registry.publish('headless-wait', headlessWait);
    await withSurfaces(h, async ({ run, createSurface, launchOn }) => {
      const runId = await launchOn('headless-wait', await createSurface());

      // The cascade as workspace's worktree delete commits it.
      await run(
        Effect.gen(function* () {
          const participant = yield* EnvironmentDeletionParticipant;
          let followUp: Effect.Effect<void> = Effect.void;
          yield* (yield* ProjectRepository).deleteWorktree(1, (db) => {
            followUp = participant.endInTransaction(db, { kind: 'worktrees', worktreeIds: [1] });
          });
          yield* followUp;
        }).pipe(
          Effect.provide(
            participantLayer.pipe(Layer.provide(Layer.succeed(InternalEvents, h.internalEvents))),
          ),
        ),
      );
      await h.settle();

      const after = runRow(h, runId);
      assert.equal(after.status, 'cancelled');
      assert.equal(after.surfaceId, null);
      assert.deepEqual(h.headless.terminated, [1]);
    });
  });
});

test('a launch onto a surface deleted before it commits is refused by name', async () => {
  await withEngine(async (h) => {
    h.registry.publish('immediate', immediate);
    // The places still list the surface, as a read made just before the delete committed would.
    h.places.surfaces.set(99, { id: 99, worktreeId: 1, title: 'Gone' });
    const failure = await h.fail(
      h.engine.launch({
        workflowKey: 'immediate',
        inputs: {},
        origin: { worktreeId: 1, surfaceId: 99 },
      }),
    );
    assert.ok(failure instanceof WorkflowEngineError);
    assert.equal(failure.code, 'surface_not_found');
    assert.equal(failure.surfaceId, 99);
    assert.deepEqual(h.db.select().from(workflowRuns).all(), []);
  });
});

test('ending a worktree ahead of its teardown cancels its runs and stops their jobs, once', async () => {
  await withEngine(async (h) => {
    h.registry.publish('headless-wait', headlessWait);
    await withSurfaces(h, async ({ run, createSurface, launchOn }) => {
      const runId = await launchOn('headless-wait', await createSurface());
      const ending = (participant: EnvironmentDeletionParticipant['Service']) =>
        participant.endBeforeTeardown({ kind: 'worktrees', worktreeIds: [1] });
      const provided = <A, E>(
        effect: Effect.Effect<A, E, EnvironmentDeletionParticipant>,
      ): Effect.Effect<A, E, RuntimeDatabase> =>
        effect.pipe(
          Effect.provide(
            participantLayer.pipe(Layer.provide(Layer.succeed(InternalEvents, h.internalEvents))),
          ),
        );

      // Before any agent is stopped, as worktree delete calls it; the worktree is still there.
      await run(provided(Effect.flatMap(EnvironmentDeletionParticipant, ending)));
      await h.settle();

      const after = runRow(h, runId);
      assert.equal(after.status, 'cancelled');
      assert.equal(after.surfaceId !== null, true, 'nothing is deleted yet');
      assert.deepEqual(h.headless.terminated, [1]);
      const cancelled = h.db
        .select()
        .from(workflowEvents)
        .where(eq(workflowEvents.runId, runId))
        .all()
        .filter((event) => event.kind === 'run_cancelled');
      assert.deepEqual(
        cancelled.map((event) => [event.message, JSON.parse(event.dataJson ?? 'null')]),
        [['Cancelled: its worktree is being deleted', { reason: 'worktree_deleted' }]],
      );

      // The cascade's own call then finds nothing left to end.
      await run(provided(Effect.flatMap(EnvironmentDeletionParticipant, ending)));
      await h.settle();
      assert.equal(
        h.db
          .select()
          .from(workflowEvents)
          .where(eq(workflowEvents.runId, runId))
          .all()
          .filter((event) => event.kind === 'run_cancelled').length,
        1,
      );
    });
  });
});

test('deleting a surface stops the headless job of a run that failed after starting it', async () => {
  await withEngine(async (h) => {
    h.registry.publish(
      'fails-after-job',
      oneNode('fails-after-job', async (ctx) => {
        await ctx.runHeadlessAgent({ harness: 'codex', prompt: 'Check.' });
        throw new Error('the node gave up');
      }),
    );
    await withSurfaces(h, async ({ run, createSurface, launchOn }) => {
      const surfaceId = await createSurface();
      const runId = await launchOn('fails-after-job', surfaceId);
      const before = runRow(h, runId);
      assert.equal(before.status, 'failed');
      const operations = () =>
        h.db
          .select()
          .from(workflowOperations)
          .where(eq(workflowOperations.runId, runId))
          .all()
          .map((op) => `${op.kind}:${op.status}`);
      assert.deepEqual(operations(), ['run_headless:running']);

      await run(SurfaceService.use((surfaces) => surfaces.deleteSurface(surfaceId)));
      await h.settle();

      const after = runRow(h, runId);
      assert.equal(after.status, 'failed', 'the failure stays the outcome');
      assert.equal(after.errorJson, before.errorJson);
      assert.equal(after.endedAt, before.endedAt);
      assert.deepEqual(operations(), ['run_headless:interrupted']);
      assert.deepEqual(h.headless.terminated, [1]);
    });
  });
});
