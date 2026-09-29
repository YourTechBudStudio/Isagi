import assert from 'node:assert/strict';
import test from 'node:test';

import {
  complete,
  createGraph,
  defineWorkflow,
  edge,
  operation,
  outcome,
  reduce,
  type OperationContext,
} from '@yourtechbudstudio/isagi-workflow-sdk';
import { eq } from 'drizzle-orm';

import { workflowEvents, workflowRuns } from '../../persistence/schema.js';
import { WorkflowEngineError } from '../errors.js';
import type { AnyWorkflowDefinition } from '../structure/loader.js';
import { withEngine, type EngineHarness } from './test-support.js';

/** Launch placement and environment preparation: what is created, recorded, and skipped on Retry. */

const runRow = (harness: EngineHarness, runId: number) =>
  harness.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get()!;
const environmentEvents = (harness: EngineHarness, runId: number) =>
  harness.db
    .select()
    .from(workflowEvents)
    .where(eq(workflowEvents.runId, runId))
    .all()
    .filter((event) => event.category === 'environment')
    .map((event) => event.kind);

function inNewWorktree(seen: string[]): AnyWorkflowDefinition {
  return defineWorkflow({
    command: () => ({ title: 'Isolated' }),
    parse: (_origin, inputs) => inputs,
    placement: () => ({
      worktree: { kind: 'create', branch: 'feature', fromRef: 'main' },
      surface: { kind: 'create', title: 'Feature' },
    }),
    graph: createGraph<{ n: number }>({
      key: 'isolated',
      title: 'Isolated',
      init: (destination) => {
        seen.push(`init at ${destination.worktreeId}/${destination.surfaceId}`);
        return { n: 0 };
      },
      state: { n: reduce.replace<number>() } as never,
      entry: 'work',
      nodes: {
        work: operation(async (ctx: OperationContext) => {
          seen.push(`work in ${ctx.destination.worktreePath}`);
          return complete();
        }),
      },
      edges: { out: edge({ from: 'work', to: ['done'], choose: () => ({ to: 'done' }) }) },
      outcomes: { done: outcome({ kind: 'success', output: () => null }) },
    }) as never,
  }) as unknown as AnyWorkflowDefinition;
}

test('preparation creates the worktree, runs setup and creates the surface, recording each', async () => {
  await withEngine(async (harness) => {
    const seen: string[] = [];
    harness.registry.publish('isolated', inNewWorktree(seen));
    const runId = await harness.launch('isolated');

    const run = runRow(harness, runId);
    assert.equal(run.status, 'completed', run.errorJson ?? '');
    assert.equal(run.worktreeId, 2);
    assert.equal(run.setupDone, true);
    assert.equal(run.surfaceId, 2);
    assert.deepEqual(JSON.parse(run.placementJson), {
      source: 'selector',
      request: {
        worktree: { kind: 'create', branch: 'feature', fromRef: 'main' },
        surface: { kind: 'create', title: 'Feature' },
      },
      baseCommit: 'a'.repeat(40),
    });
    assert.deepEqual(environmentEvents(harness, runId), [
      'worktree_created',
      'setup_finished',
      'surface_created',
    ]);
    assert.deepEqual(seen, ['init at 2/2', `work in ${run.worktreePath}`]);
  });
});

test('a failure part-way fails the run; Retry skips what exists and uses the launch commit', async () => {
  await withEngine(async (harness) => {
    harness.registry.publish('isolated', inNewWorktree([]));
    harness.places.setupResults = ['failed'];
    const runId = await harness.launch('isolated');

    let run = runRow(harness, runId);
    assert.equal(run.status, 'failed');
    assert.equal(JSON.parse(run.errorJson!).stage, 'environment');
    assert.equal(run.worktreeId, 2, 'the created worktree is kept');
    assert.equal(run.setupDone, false);
    assert.equal(run.surfaceId, null);
    assert.equal(run.endedAt !== null, true);
    assert.deepEqual(environmentEvents(harness, runId), [
      'worktree_created',
      'setup_failed',
      'preparation_failed',
    ]);
    const summary = await harness.run(harness.engine.getRun(runId));
    assert.equal(
      summary.run.controls.retry,
      true,
      'a failed preparation can retry without a surface',
    );

    // The ref moves; Retry must not care, and must not create the worktree again.
    harness.places.refs.set('main', 'b'.repeat(40));
    await harness.run(harness.engine.retry(runId));
    run = runRow(harness, runId);
    assert.equal(run.status, 'completed', run.errorJson ?? '');
    assert.deepEqual(harness.places.calls, [
      `openWorktree feature ${'a'.repeat(40)}`,
      'runWorktreeSetup 2',
      'createSurface Feature',
    ]);
  });
});

test('Retry of a preparation whose existing surface was deleted fails again, and never replaces it', async () => {
  await withEngine(async (harness) => {
    harness.registry.publish(
      'plain',
      defineWorkflow({
        command: () => ({ title: 'Plain' }),
        parse: (_origin, inputs) => inputs,
        graph: createGraph<{ n: number }>({
          key: 'plain',
          title: 'Plain',
          init: () => ({ n: 0 }),
          state: { n: reduce.replace<number>() } as never,
          entry: 'work',
          nodes: { work: operation(async () => complete()) },
          edges: { out: edge({ from: 'work', to: ['done'], choose: () => ({ to: 'done' }) }) },
          outcomes: { done: outcome({ kind: 'success', output: () => null }) },
        }) as never,
      }) as unknown as AnyWorkflowDefinition,
    );
    const surfaceId = harness.places.addSurface(1);
    const { runId } = await harness.run(
      harness.engine.launch({
        workflowKey: 'plain',
        inputs: {},
        origin: { worktreeId: 1, surfaceId: 1 },
        placement: { worktree: { kind: 'current' }, surface: { kind: 'existing', surfaceId } },
      }),
    );
    assert.equal(runRow(harness, runId).surfaceId, surfaceId);
    // Stand in for a preparation that failed, after which the surface was deleted.
    harness.db
      .update(workflowRuns)
      .set({ status: 'failed', errorJson: JSON.stringify({ stage: 'environment', message: 'x' }) })
      .where(eq(workflowRuns.id, runId))
      .run();
    harness.places.deleteSurface(surfaceId);
    assert.equal(runRow(harness, runId).surfaceId, null);

    await harness.run(harness.engine.retry(runId));
    const run = runRow(harness, runId);
    assert.equal(run.status, 'failed');
    assert.match(JSON.parse(run.errorJson!).message, /no longer exists/);
    assert.equal(run.surfaceId, null);
    assert.ok(!harness.places.calls.some((call) => call.startsWith('createSurface')));
  });
});

test('an unknown base ref is a launch rejection and leaves no run behind', async () => {
  await withEngine(async (harness) => {
    harness.registry.publish('isolated', inNewWorktree([]));
    harness.places.refs.clear();
    const refused = await harness.fail(
      harness.engine.launch({
        workflowKey: 'isolated',
        inputs: {},
        origin: { worktreeId: 1, surfaceId: 1 },
      }),
    );
    assert.ok(refused instanceof WorkflowEngineError);
    assert.equal(refused.code, 'workflow_base_ref_not_found');
    assert.equal(harness.db.select().from(workflowRuns).all().length, 0);
  });
});

test('a caller placement beats the hook, and a hook that throws is a launch rejection', async () => {
  await withEngine(async (harness) => {
    let hookCalls = 0;
    let hookThrows = false;
    harness.registry.publish(
      'placed',
      defineWorkflow({
        command: () => ({ title: 'Placed' }),
        parse: (_origin, inputs) => inputs,
        placement: async (ctx) => {
          hookCalls += 1;
          if (hookThrows) throw new Error('no idea where to run');
          const worktrees = await ctx.listWorktrees();
          return {
            worktree: { kind: 'existing', worktreeId: worktrees[0]!.id },
            surface: { kind: 'create', title: 'From the hook' },
          };
        },
        graph: createGraph<{ n: number }>({
          key: 'placed',
          title: 'Placed',
          init: () => ({ n: 0 }),
          state: { n: reduce.replace<number>() } as never,
          entry: 'work',
          nodes: { work: operation(async () => complete()) },
          edges: { out: edge({ from: 'work', to: ['done'], choose: () => ({ to: 'done' }) }) },
          outcomes: { done: outcome({ kind: 'success', output: () => null }) },
        }) as never,
      }) as unknown as AnyWorkflowDefinition,
    );

    const fromHook = await harness.launch('placed');
    assert.equal(JSON.parse(runRow(harness, fromHook).placementJson).source, 'selector');
    assert.equal(hookCalls, 1);

    const surfaceId = harness.places.addSurface(1);
    const overridden = await harness.launch('placed', {
      placement: { worktree: { kind: 'current' }, surface: { kind: 'existing', surfaceId } },
    });
    const run = runRow(harness, overridden);
    assert.equal(JSON.parse(run.placementJson).source, 'override');
    assert.equal(run.surfaceId, surfaceId);
    assert.equal(hookCalls, 1, 'the hook is not called when the caller decides');

    hookThrows = true;
    const refused = await harness.fail(
      harness.engine.launch({
        workflowKey: 'placed',
        inputs: {},
        origin: { worktreeId: 1, surfaceId: 1 },
      }),
    );
    assert.ok(refused instanceof WorkflowEngineError);
    assert.equal(refused.code, 'workflow_placement_failed');
    assert.equal(refused.message, 'no idea where to run');
  });
});

function plainWorkflow(title: string): AnyWorkflowDefinition {
  return defineWorkflow({
    command: () => ({ title }),
    parse: (_origin, inputs) => inputs,
    graph: createGraph<{ n: number }>({
      key: 'plain',
      title,
      init: () => ({ n: 0 }),
      state: { n: reduce.replace<number>() } as never,
      entry: 'work',
      nodes: { work: operation(async () => complete()) },
      edges: { out: edge({ from: 'work', to: ['done'], choose: () => ({ to: 'done' }) }) },
      outcomes: { done: outcome({ kind: 'success', output: () => null }) },
    }) as never,
  }) as unknown as AnyWorkflowDefinition;
}

test('a launch with no surface open defaults to a new surface titled after the command', async () => {
  await withEngine(async (harness) => {
    harness.registry.publish('plain', plainWorkflow('Tidy up'));
    const { runId } = await harness.run(
      harness.engine.launch({
        workflowKey: 'plain',
        inputs: {},
        origin: { worktreeId: 1, surfaceId: null },
      }),
    );

    const run = runRow(harness, runId);
    assert.equal(run.status, 'completed', run.errorJson ?? '');
    assert.equal(run.originSurfaceId, null);
    assert.deepEqual(JSON.parse(run.placementJson).request, {
      worktree: { kind: 'current' },
      surface: { kind: 'create', title: 'Tidy up' },
    });
    assert.ok(harness.places.calls.includes('createSurface Tidy up'));
    assert.notEqual(run.surfaceId, null);
    const summary = await harness.run(harness.engine.getRun(runId));
    assert.equal(summary.run.origin.surfaceId, null);
  });
});

test('a launch with no surface open refuses a current surface and a stray pane', async () => {
  await withEngine(async (harness) => {
    harness.registry.publish('plain', plainWorkflow('Plain'));
    const current = await harness.fail(
      harness.engine.launch({
        workflowKey: 'plain',
        inputs: {},
        origin: { worktreeId: 1, surfaceId: null },
        placement: { worktree: { kind: 'current' }, surface: { kind: 'current' } },
      }),
    );
    assert.ok(current instanceof WorkflowEngineError);
    assert.equal(current.code, 'workflow_placement_invalid');
    assert.equal(current.placementIssue, 'no_current_surface');

    const stray = await harness.fail(
      harness.engine.launch({
        workflowKey: 'plain',
        inputs: {},
        origin: { worktreeId: 1, surfaceId: null, paneId: 4 },
      }),
    );
    assert.ok(stray instanceof WorkflowEngineError);
    assert.equal(stray.code, 'workflow_launch_context_mismatch');
    assert.equal(harness.db.select().from(workflowRuns).all().length, 0);
  });
});
