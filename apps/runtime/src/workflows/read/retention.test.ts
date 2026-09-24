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
} from '@yourtechbudstudio/isagi-workflow-sdk';
import { Effect } from 'effect';

import type { WorkflowGraphDescriptorDto } from '@isagi/contracts';

import { makeEngineHarness, type EngineHarness } from '../engine/test-support.js';
import { run as runEffect } from '../persistence/test-support.js';
import type { AnyWorkflowDefinition } from '../structure/loader.js';
import { makeWorkflowRunProjection } from './projection.service.js';
import {
  claim,
  currentRun,
  enterRoot,
  makeReadHarness,
  PIN_A,
  run,
  startRun,
  value,
  type ReadHarness,
} from './test-support.js';

/**
 * What survives.
 *
 * Two different kinds of survival meet here. A definition may drop a node a run has already finished
 * with — ordinary refactoring — and the visit that ran under the old pin must still be readable,
 * still attributed to that pin, with the structure of both versions still available. And an
 * environment may be deleted out from under a run entirely, which takes away a place to show it and
 * nothing else: every retained record stays queryable through the global and workflow-key routes.
 */

function read<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
  return Effect.runPromise(effect as Effect.Effect<A, never>);
}

function projectionOf(harness: EngineHarness) {
  return makeWorkflowRunProjection(
    harness.fixture.database,
    harness.fixture.payloads,
    harness.fixture.content,
  );
}

/**
 * Two nodes in version one, one node in version two.
 *
 * The removed node is the one the run has already *finished* with, and the node it is parked on is
 * untouched — which is exactly the shape saved-position validation is meant to accept.
 */
function twoStepWorkflow(options: {
  readonly withWriter: boolean;
  readonly reviewerThrows: boolean;
}): AnyWorkflowDefinition {
  const reviewer = operation(async () => {
    if (options.reviewerThrows) throw new Error('the reviewer is broken in this version');
    return complete({ update: { rounds: 1 } });
  });

  const graph = createGraph<{ readonly rounds: number }, {}, Record<string, unknown>>({
    key: 'two-step',
    title: 'Two step',
    init: () => ({ rounds: 0 }),
    state: { rounds: reduce.add() } as never,
    entry: options.withWriter ? 'writer' : 'reviewer',
    nodes: (options.withWriter
      ? { writer: operation(async () => complete({ update: { rounds: 1 } })), reviewer }
      : { reviewer }) as never,
    edges: {
      ...(options.withWriter
        ? {
            'writer-out': edge({
              from: 'writer',
              to: ['reviewer'],
              choose: () => ({ to: 'reviewer' }),
            }),
          }
        : {}),
      'reviewer-out': edge({ from: 'reviewer', to: ['done'], choose: () => ({ to: 'done' }) }),
    },
    outcomes: {
      done: outcome({ kind: 'success', output: (state) => ({ rounds: state.rounds }) }),
    },
  });

  return defineWorkflow({
    command: () => ({ title: 'Two step' }),
    validate: () => {},
    graph,
  }) as AnyWorkflowDefinition;
}

test('a node removed by the adopted version keeps its historical visit, on the pin that ran it', async () => {
  const harness = await makeEngineHarness();
  try {
    const pinA = harness.publish({
      workflowKey: 'two-step',
      version: '1',
      definition: twoStepWorkflow({ withWriter: true, reviewerThrows: true }),
    });
    const launched = await harness.launch({ workflowKey: 'two-step' });
    await harness.drain();

    const failed = await harness.runOf(launched.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failureCode, 'node_callback_failed');

    // Version two deletes the node the run already finished with, and repairs the one it is on.
    const pinB = harness.publish({
      workflowKey: 'two-step',
      version: '2',
      definition: twoStepWorkflow({ withWriter: false, reviewerThrows: false }),
    });
    harness.setCurrent('two-step', '2');
    const retried = await runEffect(harness.controls.retry(launched.id));
    assert.equal(retried.accepted, true, 'a node the run is not parked on may be deleted');
    assert.deepEqual(retried.diagnostics, []);
    await harness.drain();
    assert.equal((await harness.runOf(launched.id)).status, 'done');

    const projection = projectionOf(harness);
    const executions = await read(projection.listRunExecutions(launched.id, {}));
    const writer = executions.items.find((item) => item.nodeId === 'writer');
    const reviewer = executions.items.find((item) => item.nodeId === 'reviewer')!;

    // The historical visit is still there, still on the pin that ran it, with its own facts.
    assert.ok(writer, 'a visit is not erased by a later version that dropped its node');
    assert.equal(writer!.firstArtifactHash, pinA);
    assert.equal(writer!.latestArtifactHash, pinA, 'work already done is not re-attributed');
    assert.equal(writer!.status, 'completed');
    assert.equal(writer!.latestAttempt?.status, 'succeeded');
    assert.equal(writer!.routing?.chosen, 'reviewer');
    const writerAttempts = await read(
      projection.listAttempts(launched.id, { executionId: writer!.executionId }),
    );
    assert.ok(writerAttempts.items.length >= 1);
    assert.deepEqual([...new Set(writerAttempts.items.map((item) => item.artifactHash))], [pinA]);

    // The repaired visit reads as the two pins it actually spanned.
    assert.equal(reviewer.firstArtifactHash, pinA);
    assert.equal(reviewer.latestArtifactHash, pinB);
    assert.deepEqual(
      reviewer.priorFailures.map((failure) => [failure.failure.code, failure.artifactHash]),
      [['node_callback_failed', pinA]],
    );

    // Current structure is the adopted one, and it no longer declares the removed node; the old one
    // is still readable at its own ordinal, without importing anything.
    const current = await read(projection.getStructure(launched.id, {}));
    assert.equal(current.artifactHash, pinB);
    assert.equal(current.pinOrdinal, 2);
    const currentNodes = nodeIdsOf(current.descriptor.graphs, 'two-step');
    assert.deepEqual(currentNodes, ['reviewer']);

    const historical = await read(projection.getStructure(launched.id, { artifactHash: pinA }));
    assert.equal(historical.pinOrdinal, 1);
    assert.deepEqual([...nodeIdsOf(historical.descriptor.graphs, 'two-step')].sort(), [
      'reviewer',
      'writer',
    ]);
  } finally {
    await harness.close();
  }
});

function nodeIdsOf(
  graphs: readonly WorkflowGraphDescriptorDto[],
  graphKey: string,
): readonly string[] {
  return (graphs.find((graph) => graph.key === graphKey)?.nodes ?? []).map((node) => node.id);
}

async function withReadHarness(body: (harness: ReadHarness) => Promise<void>) {
  const harness = makeReadHarness();
  try {
    await body(harness);
  } finally {
    harness.close();
  }
}

/** A run with a frame, a visit, an attempt, an operation and history to lose. */
async function runWithHistory(harness: ReadHarness, workflowKey: string) {
  const { runId, rootFrameId, placement } = await startRun(harness.fixture, { workflowKey });
  const execution = await enterRoot(harness.fixture, {
    runId,
    frameId: rootFrameId,
    nodeId: 'writer',
  });
  const attempt = await claim(harness.fixture, runId);
  const recorded = value(
    await run(
      harness.fixture.operations.recordIntent({
        runId,
        frameId: rootFrameId,
        executionId: execution.id,
        originAttemptId: attempt.attempt.id,
        capability: 'send_agent_prompt',
        callIndex: 0,
        request: { value: { prompt: 'write it' } },
        fingerprintOf: { value: { prompt: 'write it' } },
        artifactHash: PIN_A,
      }),
    ),
  );
  return { runId, rootFrameId, placement, executionId: execution.id, operation: recorded };
}

/** Everything a client can still ask about a run, asserted to be intact. */
async function assertFullyReadable(
  harness: ReadHarness,
  scenario: Awaited<ReturnType<typeof runWithHistory>>,
  workflowKey: string,
) {
  const global = await read(harness.projection.listRuns({}));
  assert.ok(
    global.items.some((item) => item.runId === scenario.runId),
    'the global listing still has it',
  );
  const byKey = await read(harness.projection.listRuns({ workflowKey }));
  assert.deepEqual(
    byKey.items.map((item) => item.runId),
    [scenario.runId],
    'and so does the workflow-key listing',
  );

  const executions = await read(harness.projection.listRunExecutions(scenario.runId, {}));
  assert.deepEqual(
    executions.items.map((item) => item.executionId),
    [scenario.executionId],
  );
  const frames = await read(harness.projection.listFrames(scenario.runId, {}));
  assert.equal(frames.items.length, 1);
  assert.ok(frames.items[0]!.entry !== null, 'frame-owned segment facts survive too');
  const attempts = await read(harness.projection.listAttempts(scenario.runId, {}));
  assert.ok(attempts.items.length >= 2);
  const operations = await read(harness.projection.listOperations(scenario.runId, {}));
  assert.deepEqual(
    operations.items.map((item) => item.operationKey),
    [scenario.operation.operationKey],
  );
  const events = await read(harness.projection.listEvents(scenario.runId, { sinceRevision: 0 }));
  assert.ok(events.items.length > 0, 'history is retained in full');
  assert.equal(events.boundary.complete, true);
  const structure = await read(harness.projection.getStructure(scenario.runId, {}));
  assert.equal(structure.artifactHash, PIN_A, 'the pin is still describable without any code');
  const versions = await read(harness.projection.listVersions(scenario.runId, {}));
  assert.equal(versions.items.length, 1);
}

test('deleting a surface takes the place to show a run, and nothing else', async () => {
  await withReadHarness(async (harness) => {
    const scenario = await runWithHistory(harness, 'surface-loss');

    // The owner deletes the surface and publishes it; the workflow domain finds the affected runs by
    // retained destination identity and records the loss, exactly as the environment watch does.
    harness.fixture.client
      .prepare('DELETE FROM worktree_surfaces WHERE id = ?')
      .run(scenario.placement.surfaceId);
    const affected = await run(
      harness.fixture.runs.listByDestinationSurface(scenario.placement.surfaceId),
    );
    assert.deepEqual(
      affected.map((item) => item.id),
      [scenario.runId],
      'runs are found by retained identity, not through the attachment that just cascaded',
    );
    await run(
      harness.fixture.runs.applyEnvironmentAvailability({
        runIds: [scenario.runId],
        available: false,
      }),
    );

    const summary = (await read(harness.projection.getRun(scenario.runId))).run;
    assert.equal(summary.attachment?.worktreeId, scenario.placement.worktreeId);
    assert.equal(summary.attachment?.surfaceId, null, 'the surface association is what was lost');
    assert.equal(summary.destination.available, false);
    assert.equal(
      summary.destination.surfaceId,
      scenario.placement.surfaceId,
      'provenance still names what was deleted',
    );
    assert.equal(summary.paused, true, 'and the run is gated rather than dispatched into nothing');
    await assertFullyReadable(harness, scenario, 'surface-loss');

    const revisionBefore = (await currentRun(harness.fixture, scenario.runId)).revision;
    await read(harness.projection.listRunExecutions(scenario.runId, {}));
    await read(harness.projection.getStructure(scenario.runId, {}));
    assert.equal(
      (await currentRun(harness.fixture, scenario.runId)).revision,
      revisionBefore,
      'reading a run whose environment went away repairs nothing and records nothing',
    );
  });
});

test('deleting a project takes the environment, and a stopped run stops claiming a surface', async () => {
  await withReadHarness(async (harness) => {
    const scenario = await runWithHistory(harness, 'project-loss');
    const active = await currentRun(harness.fixture, scenario.runId);
    value(
      await run(
        harness.fixture.runs.applyCancel({
          runId: scenario.runId,
          controlRevision: active.controlRevision,
        }),
      ),
    );

    harness.fixture.client
      .prepare('DELETE FROM projects WHERE id = (SELECT project_id FROM worktrees WHERE id = ?)')
      .run(scenario.placement.worktreeId);
    assert.equal(
      (
        harness.fixture.client
          .prepare('SELECT count(*) as count FROM worktrees WHERE id = ?')
          .get(scenario.placement.worktreeId) as { count: number }
      ).count,
      0,
      'the environment rows really did cascade away',
    );
    await run(
      harness.fixture.runs.applyEnvironmentAvailability({
        runIds: [scenario.runId],
        available: false,
      }),
    );

    const summary = (await read(harness.projection.getRun(scenario.runId))).run;
    assert.equal(
      summary.attachment,
      null,
      'a stopped run whose environment is gone stops reporting a surface it no longer occupies',
    );
    assert.equal(summary.status, 'cancelled', 'and is not parked: there is nothing left to gate');
    assert.equal(summary.paused, false);
    assert.equal(summary.controls.dismiss, false, 'there is no attachment left to release');
    assert.equal(summary.destination.available, false);
    assert.equal(summary.destination.worktreeId, scenario.placement.worktreeId);
    assert.equal(summary.origin.worktreePath, '/repo/fixture', 'origin provenance is immutable');
    await assertFullyReadable(harness, scenario, 'project-loss');

    const revisionBefore = (await currentRun(harness.fixture, scenario.runId)).revision;
    await read(harness.projection.listOperations(scenario.runId, {}));
    await read(harness.projection.listEvents(scenario.runId, { sinceRevision: 0 }));
    assert.equal(
      (await currentRun(harness.fixture, scenario.runId)).revision,
      revisionBefore,
      'and still nothing was written on a read path',
    );
  });
});

test('a run whose environment is gone is not offered Resume, because the runtime would refuse it', async () => {
  await withReadHarness(async (harness) => {
    const scenario = await runWithHistory(harness, 'no-resume');
    const before = (await read(harness.projection.getRun(scenario.runId))).run;
    assert.equal(before.controls.resume, false, 'a running run has nothing to resume yet');

    harness.fixture.client
      .prepare('DELETE FROM worktrees WHERE id = ?')
      .run(scenario.placement.worktreeId);
    const changed = await run(
      harness.fixture.runs.applyEnvironmentAvailability({
        runIds: [scenario.runId],
        available: false,
      }),
    );
    assert.deepEqual(changed, [scenario.runId]);

    const parked = (await read(harness.projection.getRun(scenario.runId))).run;
    assert.equal(parked.paused, true, 'the run is gated');
    assert.equal(
      parked.controls.resume,
      false,
      'and Resume is not offered for a destination the write would refuse',
    );
    assert.equal(parked.controls.retry, false, 'nor Retry, which cannot resolve a version either');
    assert.equal(parked.controls.pause, false, 'already gated');
    assert.equal(parked.controls.cancel, true, 'stopping a run never needs its environment');

    // The refusal the summary is speaking for: the control itself rejects this exact state.
    const current = await currentRun(harness.fixture, scenario.runId);
    const refused = await run(
      harness.fixture.runs.applyResume({
        runId: scenario.runId,
        controlRevision: current.controlRevision,
        expectedPosition: current.position,
      }),
    );
    assert.equal(refused.ok, false);
    assert.equal(
      (refused as { rejection: { kind: string } }).rejection.kind,
      'environment_unavailable',
      'the summary and the write agree about the same precondition',
    );
  });
});

test('environment loss and restoration are each one recorded, idempotent transaction', async () => {
  await withReadHarness(async (harness) => {
    const scenario = await runWithHistory(harness, 'gate-history');
    const startedAt = (await currentRun(harness.fixture, scenario.runId)).revision;
    const worktree = harness.fixture.client
      .prepare('SELECT id, project_id, path FROM worktrees WHERE id = ?')
      .get(scenario.placement.worktreeId) as { id: number; project_id: number; path: string };
    // The surface goes with its worktree, and has to come back with it: `destination.available`
    // means the whole placement, which is the same rule Resume's own write applies.
    const surface = harness.fixture.client
      .prepare('SELECT id, title FROM worktree_surfaces WHERE id = ?')
      .get(scenario.placement.surfaceId) as { id: number; title: string };

    harness.fixture.client
      .prepare('DELETE FROM worktrees WHERE id = ?')
      .run(scenario.placement.worktreeId);
    await run(
      harness.fixture.runs.applyEnvironmentAvailability({
        runIds: [scenario.runId],
        available: false,
      }),
    );
    // Repeating the same absence says nothing more and draws no second band.
    const repeated = await run(
      harness.fixture.runs.applyEnvironmentAvailability({
        runIds: [scenario.runId],
        available: false,
      }),
    );
    assert.deepEqual(repeated, [], 'an absence already on record is not news');
    const intervals = await run(harness.fixture.runs.listPauseIntervals(scenario.runId));
    assert.equal(intervals.length, 1, 'one absence, one band');

    // The environment comes back — and restoration is its own recorded fact, which lifts nothing.
    harness.fixture.client
      .prepare(
        `INSERT INTO worktrees (id, project_id, path, branch, head, sort_order, created_at, updated_at, first_seen_at)
         VALUES (?, ?, ?, 'main', NULL, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run(worktree.id, worktree.project_id, worktree.path);
    harness.fixture.client
      .prepare(
        `INSERT INTO worktree_surfaces (id, worktree_id, title, layout_json, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, '{}', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run(surface.id, worktree.id, surface.title);
    const restored = await run(
      harness.fixture.runs.applyEnvironmentAvailability({
        runIds: [scenario.runId],
        available: true,
      }),
    );
    assert.deepEqual(restored, [scenario.runId]);
    const after = (await read(harness.projection.getRun(scenario.runId))).run;
    assert.equal(after.paused, true, 'a returning worktree does not decide to continue the work');
    assert.equal(after.destination.available, true);
    assert.equal(after.controls.resume, true, 'but Resume is offered again, because it would work');

    // Every one of those facts is deliverable: the client sees them as ordinary revisions.
    const events = await read(
      harness.projection.listEvents(scenario.runId, { sinceRevision: startedAt }),
    );
    const kinds = events.items.map((delta) => delta.transition.kind);
    assert.deepEqual(kinds, ['pause_opened', 'control_applied', 'control_applied']);
    assert.equal(events.boundary.complete, true);
    assert.equal(
      events.items.at(-1)!.changes.summary?.revision,
      events.items.at(-1)!.revision,
      'and the summary they produced rides the revision that produced it',
    );
  });
});

test('Resume is refused while the availability gate is down, even where the placement is live', async () => {
  await withReadHarness(async (harness) => {
    const scenario = await runWithHistory(harness, 'stale-gate');
    // The gate down while the placement is demonstrably fine — the environment rows are never
    // touched here. That is the race the gate exists for: a deletion notification arrives, the
    // runtime records the absence, and the world turns out to still have the worktree and surface.
    // The availability cache is derived at startup, so it can lag a world that changed underneath
    // it, and until it is re-derived the *claim* will refuse this run.
    await run(
      harness.fixture.runs.applyEnvironmentAvailability({
        runIds: [scenario.runId],
        available: false,
      }),
    );

    const summary = (await read(harness.projection.getRun(scenario.runId))).run;
    assert.equal(summary.destination.available, true, 'the placement really is there');
    assert.equal(summary.paused, true);
    assert.equal(
      summary.controls.resume,
      false,
      'and Resume is still not offered, because the claim would refuse the run',
    );

    const current = await currentRun(harness.fixture, scenario.runId);
    const revisionBefore = current.revision;
    const refused = await run(
      harness.fixture.runs.applyResume({
        runId: scenario.runId,
        controlRevision: current.controlRevision,
        expectedPosition: current.position,
      }),
    );
    assert.equal(refused.ok, false);
    assert.equal(
      (refused as { rejection: { kind: string } }).rejection.kind,
      'environment_unavailable',
    );
    const after = await currentRun(harness.fixture, scenario.runId);
    assert.equal(after.paused, true, 'the refusal changed nothing');
    assert.equal(after.revision, revisionBefore);
    assert.equal(after.controlRevision, current.controlRevision);
  });
});
