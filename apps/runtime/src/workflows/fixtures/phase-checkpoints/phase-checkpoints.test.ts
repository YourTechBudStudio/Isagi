import assert from 'node:assert/strict';
import test from 'node:test';

import { Cause, Effect, Option } from 'effect';

import type { EngineHarness } from '../../engine/test-support.js';
import { run } from '../../persistence/test-support.js';
import { WorkflowEngineError } from '../../types.js';
import { projectionOf, withHarness } from '../drive.js';
import {
  checkpointRowCount,
  executionsOf,
  fileText,
  initDestinationRepository,
  listAllCheckpoints,
  listAllInventory,
  publishPhaseCheckpoints,
} from './drive.js';
import { phasePrepare, type PhaseCheckpointsVariant } from './index.js';

/**
 * Checkpoints driven through the real engine: dispatch by the execution's durable node kind, the
 * receipt check before author code, the capture service over real Git, and the production reads.
 *
 * Every assertion is about the record: which visit saved which checkpoint, what each one's final
 * state is, and that a failure, a crash or a Cancel never leaves a successful-looking partial row.
 */

async function withRepository(
  body: (harness: EngineHarness, head: string) => Promise<void>,
): Promise<void> {
  await withHarness(async (harness) => {
    const repository = initDestinationRepository(harness);
    try {
      await body(harness, repository.head);
    } finally {
      repository.cleanup();
    }
  });
}

/** Launches one variant and drains until nothing moves. */
async function launchAndDrain(harness: EngineHarness, variant: PhaseCheckpointsVariant = {}) {
  publishPhaseCheckpoints(harness, variant);
  const launched = await harness.launch({ workflowKey: 'phase-checkpoints' });
  await harness.drain();
  return { runId: launched.id, finished: await harness.runOf(launched.id) };
}

/** The failed attempt's code and resolved detail, for a run that stopped on a segment failure. */
async function failureOf(harness: EngineHarness, runId: number) {
  const failed = await harness.runOf(runId);
  assert.equal(failed.status, 'failed');
  const attempt = (await run(harness.fixture.runs.findAttempt(failed.failureAttemptId!)))!;
  const detail = attempt.failureDetail
    ? ((await run(harness.fixture.payloads.resolve(attempt.failureDetail))) as Record<
        string,
        unknown
      >)
    : null;
  return { code: failed.failureCode, attempt, detail };
}

test('two loop visits and one nested visit save three linked checkpoints', async () => {
  await withRepository(async (harness, head) => {
    const { runId, finished } = await launchAndDrain(harness);
    assert.equal(finished.status, 'done');

    const checkpoints = await listAllCheckpoints(harness, runId);
    assert.deepEqual(
      checkpoints.map((checkpoint) => [checkpoint.nodeId, checkpoint.title]),
      [
        ['save', 'Phase 1 saved'],
        ['save', 'Phase 2 saved'],
        // No title from `prepare`: the static node title is the default.
        ['seal', 'Seal'],
      ],
    );
    assert.equal(new Set(checkpoints.map((checkpoint) => checkpoint.executionId)).size, 3);
    assert.equal(new Set(checkpoints.map((checkpoint) => checkpoint.attemptId)).size, 3);
    assert.equal(checkpoints[0]!.frameId, checkpoints[1]!.frameId, 'both loop visits are root');
    assert.notEqual(checkpoints[2]!.frameId, checkpoints[0]!.frameId, 'the seal is nested');
    for (const checkpoint of checkpoints) {
      assert.deepEqual(checkpoint.base, {
        kind: 'git',
        repositoryId: checkpoint.base.kind === 'git' ? checkpoint.base.repositoryId : 0,
        commitSha: head,
      });
    }

    // Run-linear parentage, across the loop and into the nested frame.
    const projection = projectionOf(harness);
    const details = await Promise.all(
      checkpoints.map((checkpoint) =>
        Effect.runPromise(projection.getCheckpoint(runId, checkpoint.checkpointId)),
      ),
    );
    assert.deepEqual(
      details.map((detail) => detail.checkpoint.parentCheckpointId),
      [null, checkpoints[0]!.checkpointId, checkpoints[1]!.checkpointId],
    );

    // Each visit is linked to its own checkpoint in the execution projection, and only those.
    const executions = await executionsOf(harness, runId);
    const linked = executions.filter((execution) => execution.checkpoint !== null);
    assert.deepEqual(
      linked.map((execution) => [execution.executionId, execution.checkpoint!.checkpointId]),
      checkpoints.map((checkpoint) => [checkpoint.executionId, checkpoint.checkpointId]),
    );
    assert.ok(
      executions
        .filter((execution) => execution.nodeKind !== 'checkpoint')
        .every((execution) => execution.checkpoint === null),
    );
    // The instance title lives on the checkpoint, never as the visit's display name.
    assert.ok(linked.every((execution) => execution.displayName === null));

    const files = (entries: Awaited<ReturnType<typeof listAllInventory>>) =>
      entries.flatMap((entry) => (entry.kind === 'file' ? [entry.path] : [])).sort();

    // Phase 1 saved its draft; phase 2 deleted it but did not recapture phase 1, so it inherits.
    const first = await listAllInventory(harness, runId, checkpoints[0]!.checkpointId);
    assert.deepEqual(files(first), [
      'decisions.md',
      'scratch/phase-1/draft.md',
      'scratch/phase-1/plan.md',
    ]);
    const second = await listAllInventory(harness, runId, checkpoints[1]!.checkpointId);
    assert.deepEqual(files(second), [
      'decisions.md',
      'scratch/phase-1/draft.md',
      'scratch/phase-1/plan.md',
      'scratch/phase-2/plan.md',
    ]);
    // The seal recaptures all of `scratch`, so the deleted draft leaves the final state.
    const sealed = await listAllInventory(harness, runId, checkpoints[2]!.checkpointId);
    assert.deepEqual(files(sealed), [
      'decisions.md',
      'scratch/phase-1/plan.md',
      'scratch/phase-2/plan.md',
    ]);

    // Layers are immutable: the first checkpoint's decisions file is still its own bytes.
    const decisions = (entries: typeof first) =>
      entries.find((entry) => entry.kind === 'file' && entry.path === 'decisions.md')!;
    const firstDecisions = decisions(first);
    assert.equal(firstDecisions.kind, 'file');
    assert.equal(
      await fileText(
        harness,
        runId,
        checkpoints[0]!.checkpointId,
        firstDecisions.kind === 'file' ? firstDecisions.fileId : '',
      ),
      '- phase 1\n',
    );
    const lastDecisions = decisions(sealed);
    assert.equal(
      await fileText(
        harness,
        runId,
        checkpoints[2]!.checkpointId,
        lastDecisions.kind === 'file' ? lastDecisions.fileId : '',
      ),
      '- phase 1\n- phase 2\n',
    );

    // The segment committed the checkpoint key as its producer output, under the producing pin.
    const attempt = (await run(harness.fixture.runs.findAttempt(checkpoints[0]!.attemptId)))!;
    assert.deepEqual(await run(harness.fixture.payloads.resolve(attempt.producerOutput!)), {
      type: 'complete',
      checkpointId: checkpoints[0]!.checkpointId,
    });
    assert.equal(attempt.producerArtifactHash, details[0]!.checkpoint.artifactHash);
  });
});

test('optional plan fields set to undefined are absent, not a failure', async () => {
  await withRepository(async (harness) => {
    const { runId, finished } = await launchAndDrain(harness, {
      savePrepare: (state) => ({
        title: undefined,
        capture: [
          {
            scope: `phase-${state.phase}`,
            directory: `scratch/phase-${state.phase}`,
            exclude: undefined,
          },
        ],
      }),
    });
    assert.equal(finished.status, 'done');
    const checkpoints = await listAllCheckpoints(harness, runId);
    assert.deepEqual(
      checkpoints.map((checkpoint) => checkpoint.title),
      ['Save the phase', 'Save the phase', 'Seal'],
    );
  });
});

test('a prepare that throws, returns a promise, or returns a malformed plan saves nothing', async () => {
  const cases: {
    readonly name: string;
    readonly prepare: NonNullable<PhaseCheckpointsVariant['savePrepare']>;
    readonly code: string;
    readonly detail: (detail: Record<string, unknown> | null) => void;
  }[] = [
    {
      name: 'throws',
      prepare: () => {
        throw new Error('no plan today');
      },
      code: 'checkpoint_prepare_failed',
      detail: (detail) => assert.match(String(detail?.cause), /no plan today/),
    },
    {
      name: 'returns a promise',
      prepare: async () => ({ capture: [] }),
      code: 'async_pure_callback',
      detail: (detail) => assert.equal(detail, null),
    },
    {
      name: 'returns no capture list',
      prepare: () => ({ capture: 'scratch' }),
      code: 'checkpoint_prepare_failed',
      detail: (detail) =>
        assert.deepEqual(detail, { reason: 'invalid_plan_shape', field: 'capture' }),
    },
    {
      name: 'returns a function as a scope',
      prepare: () => ({ capture: [() => 'scratch'] }),
      code: 'checkpoint_prepare_failed',
      detail: (detail) =>
        assert.deepEqual(detail, { reason: 'invalid_scope_shape', field: 'capture[0]' }),
    },
    {
      name: 'returns a non-string title',
      prepare: () => ({ title: 7, capture: [] }),
      code: 'checkpoint_prepare_failed',
      detail: (detail) => assert.deepEqual(detail, { reason: 'invalid_title', field: 'title' }),
    },
  ];
  for (const scenario of cases) {
    await withRepository(async (harness) => {
      const { runId } = await launchAndDrain(harness, { savePrepare: scenario.prepare });
      const failure = await failureOf(harness, runId);
      assert.equal(failure.code, scenario.code, scenario.name);
      scenario.detail(failure.detail);
      assert.equal(checkpointRowCount(harness, runId), 0, `${scenario.name}: no row`);
      const executions = await executionsOf(harness, runId);
      assert.ok(executions.every((execution) => execution.checkpoint === null));
    });
  }
});

test('a refused capture fails the visit by name and leaves no checkpoint row', async () => {
  await withRepository(async (harness) => {
    const { runId } = await launchAndDrain(harness, {
      savePrepare: () => ({ capture: [{ scope: 'missing', directory: 'never/written' }] }),
    });
    const failure = await failureOf(harness, runId);
    assert.equal(failure.code, 'checkpoint_capture_failed');
    assert.equal(failure.detail?.reason, 'scope_path_not_found');
    assert.equal(failure.detail?.scopeId, 'missing');
    assert.equal(checkpointRowCount(harness, runId), 0);
    // Nothing was reused, so a Retry runs the capture again.
    assert.equal(failure.attempt.producerOutput, null);
  });
});

test('a crash after the checkpoint row commits is resumed by reusing that row, not capturing again', async () => {
  await withRepository(async (harness) => {
    let prepared = 0;
    publishPhaseCheckpoints(harness, {
      savePrepare: (state) => {
        prepared += 1;
        return phasePrepare(state);
      },
    });
    const launched = await harness.launch({ workflowKey: 'phase-checkpoints' });

    // The first `save` visit captures and commits its row; the segment commit then fails as a
    // killed process would leave it.
    harness.crashNext('commitNodeResult', 1);
    await harness.drain();
    const crashed = await harness.runOf(launched.id);
    assert.equal(crashed.position.kind, 'node_callback');
    assert.equal(crashed.failureCode, null);
    assert.equal(checkpointRowCount(harness, launched.id), 1);
    assert.equal(prepared, 1);
    const [saved] = await listAllCheckpoints(harness, launched.id);

    await harness.restart();
    assert.equal((await run(harness.controls.resume(launched.id))).accepted, true);
    await harness.drain();

    assert.equal((await harness.runOf(launched.id)).status, 'done');
    const checkpoints = await listAllCheckpoints(harness, launched.id);
    assert.equal(checkpoints.length, 3, 'no visit captured twice');
    assert.equal(checkpoints[0]!.checkpointId, saved!.checkpointId);
    // One `prepare` per visit: the re-entered visit read its receipt before any author code.
    assert.equal(prepared, 2);

    // The re-entered visit committed the existing row under the pin that produced it.
    const execution = (await executionsOf(harness, launched.id)).find(
      (candidate) => candidate.executionId === saved!.executionId,
    )!;
    assert.equal(execution.checkpoint?.checkpointId, saved!.checkpointId);
    const attempts = await run(harness.fixture.runs.listAttemptsForFrame(checkpoints[0]!.frameId));
    const committed = attempts.find(
      (attempt) => attempt.executionId === saved!.executionId && attempt.status === 'succeeded',
    )!;
    assert.notEqual(committed.id, saved!.attemptId, 'a new attempt committed the saved row');
    assert.deepEqual(await run(harness.fixture.payloads.resolve(committed.producerOutput!)), {
      type: 'complete',
      checkpointId: saved!.checkpointId,
    });
    const detail = await Effect.runPromise(
      projectionOf(harness).getCheckpoint(launched.id, saved!.checkpointId),
    );
    assert.equal(committed.producerArtifactHash, detail.checkpoint.artifactHash);
  });
});

test('a Cancel that lands after the row commits keeps the checkpoint and does not advance', async () => {
  await withRepository(async (harness) => {
    publishPhaseCheckpoints(harness);
    const launched = await harness.launch({ workflowKey: 'phase-checkpoints' });
    harness.onCheckpointCaptured(async () => {
      harness.onCheckpointCaptured(() => {});
      assert.equal((await run(harness.controls.cancel(launched.id))).accepted, true);
    });
    await harness.drain();

    const cancelled = await harness.runOf(launched.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.position.kind, 'node_callback', 'the run did not route onward');

    const checkpoints = await listAllCheckpoints(harness, launched.id);
    assert.equal(checkpoints.length, 1, 'the saved checkpoint is retained and discoverable');
    const attempt = (await run(harness.fixture.runs.findAttempt(checkpoints[0]!.attemptId)))!;
    assert.equal(attempt.status, 'cancelled');
    // The visit's projection was refreshed by the Cancel, so a client sees the retained row.
    const execution = (await executionsOf(harness, launched.id)).find(
      (candidate) => candidate.executionId === checkpoints[0]!.executionId,
    )!;
    assert.equal(execution.checkpoint?.checkpointId, checkpoints[0]!.checkpointId);
    // The shape the canvas reads: Cancel ends the attempt, and the visit itself stays running.
    assert.equal(execution.status, 'running');
    assert.equal(execution.latestAttempt?.status, 'cancelled');
  });
});

test('Retry refuses a version that turns the parked checkpoint into an operation', async () => {
  await withRepository(async (harness) => {
    const { runId } = await launchAndDrain(harness, {
      savePrepare: () => {
        throw new Error('not yet');
      },
    });
    assert.equal((await failureOf(harness, runId)).code, 'checkpoint_prepare_failed');

    publishPhaseCheckpoints(harness, { saveAsOperation: true }, '2');
    const exit = await Effect.runPromiseExit(harness.controls.retry(runId));
    assert.equal(exit._tag, 'Failure', 'expected the control to refuse');
    const failure =
      exit._tag === 'Failure' ? Option.getOrNull(Cause.failureOption(exit.cause)) : null;
    assert.ok(failure instanceof WorkflowEngineError);
    assert.equal(failure.code, 'workflow_structure_validation_failed');
    assert.deepEqual(
      failure.diagnostics?.map((diagnostic) => diagnostic.code),
      ['node_kind_changed'],
    );
    assert.equal(checkpointRowCount(harness, runId), 0);
  });
});
