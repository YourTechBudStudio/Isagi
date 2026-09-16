import assert from 'node:assert/strict';
import test from 'node:test';

import type { OperationContext } from '@yourtechbudstudio/isagi-workflow-sdk';
import { Effect } from 'effect';

import {
  crashingOperationsRepository,
  makeOperationHarness,
  run,
  runCallback,
  type OperationHarness,
} from './test-support.js';

/**
 * The history an operation leaves behind.
 *
 * These transitions are the only way a reconnecting client learns that an operation moved, so a
 * stage that advances without appending one is invisible to every reader that is not already
 * holding the row. Phase 05's paginated recovery reads exactly this table, which is why the
 * assertions are about revisions and identities rather than about counts alone.
 */

const prompt = { harness: 'claude' as const, prompt: 'judge this' };

interface TransitionRow {
  readonly revision: number;
  readonly kind: string;
  readonly operation_id: number | null;
  readonly execution_id: number | null;
  readonly attempt_id: number | null;
  readonly detail_inline: string | null;
}

function transitions(harness: OperationHarness): readonly TransitionRow[] {
  return harness.fixture.client
    .prepare(
      `SELECT revision, kind, operation_id, execution_id, attempt_id, detail_inline
         FROM workflow_transitions WHERE run_id = ? ORDER BY revision`,
    )
    .all(harness.identity.runId) as TransitionRow[];
}

async function invoke<A>(
  harness: OperationHarness,
  callback: (ctx: OperationContext) => Promise<A>,
  options?: Parameters<OperationHarness['service']>[0],
) {
  const built = await harness.service(options ?? {});
  try {
    return await runCallback(
      built.service.withAttemptContext(harness.identity, (ctx) =>
        Effect.tryPromise({ try: () => callback(ctx), catch: (cause) => cause }),
      ),
    ).catch((cause) => ({ crashed: cause }));
  } finally {
    await built.close();
  }
}

test('an operation appends a transition for its intent, every stage it reaches, and its settlement', async () => {
  const harness = await makeOperationHarness();
  try {
    const built = await harness.service();
    let key = '';
    try {
      const outcome = await runCallback(
        built.service.withAttemptContext(harness.identity, (ctx) =>
          Effect.tryPromise({ try: () => ctx.runHeadlessAgent(prompt), catch: (c) => c }),
        ),
      );
      key = outcome.value.operationId;
      const record = (await run(harness.fixture.operations.findByKey(key)))!;
      harness.state.capturedOutput.set(record.ptyProcessId!, { raw: 'done', output: 'done' });
      await Effect.runPromise(
        built.bus.publish({
          type: 'pty_process_exited',
          status: 'exited',
          ptyProcessId: record.ptyProcessId!,
          exitCode: 0,
          signal: null,
        }),
      );
      await settled(harness, key);
    } finally {
      await built.close();
    }

    const operation = (await run(harness.fixture.operations.findByKey(key)))!;
    const own = transitions(harness).filter((row) => row.operation_id === operation.id);

    assert.deepEqual(
      own.map((row) => row.kind),
      [
        'operation_recorded',
        'operation_recorded',
        'operation_recorded',
        'operation_recorded',
        'operation_settled',
      ],
      'intent, then one per stage reached, then the settlement',
    );
    const details = own.map((row) => JSON.parse(row.detail_inline ?? '{}'));
    // The intent names what is about to be attempted; it has no stage, because nothing has crossed a
    // boundary yet.
    assert.deepEqual(details[0], { capability: 'run_headless_agent', state: 'intended' });
    assert.deepEqual(
      details.slice(1, 4).map((detail) => detail.stage),
      ['allocated', 'starting', 'started'],
      'every stage the recovery rules read is separately visible',
    );
    assert.equal(details[4]?.stage, undefined, 'the settlement carries the result, not a stage');
    // Correlated to the execution and the attempt that produced them, so a reader can attribute an
    // effect to the try that caused it rather than to the operation in aggregate.
    for (const row of own) {
      assert.equal(row.execution_id, harness.identity.executionId);
    }
    assert.equal(own[0]!.attempt_id, harness.identity.attemptId);
  } finally {
    harness.close();
  }
});

test('the run history is one contiguous revision sequence, with no gap and no repeat', async () => {
  const harness = await makeOperationHarness();
  try {
    await invoke(harness, async (ctx) => {
      await ctx.log('info', 'starting');
      await ctx.runHeadlessAgent({ ...prompt, prompt: 'A' });
      await ctx.runHeadlessAgent({ ...prompt, prompt: 'B' });
    });
    const rows = transitions(harness);
    const revisions = rows.map((row) => row.revision);
    assert.deepEqual(
      revisions,
      revisions.map((_, index) => index + 1),
      'a reader acknowledging coverage to a revision must not be skipping one',
    );
    assert.equal(new Set(revisions).size, revisions.length);
  } finally {
    harness.close();
  }
});

test('a stage advance is recoverable from history even though the operation never settled', async () => {
  const harness = await makeOperationHarness();
  try {
    // The whole point of recording stage advances: `seed_submitting` is precisely the fact that
    // decides never to resend, and a client that reconnects before any settlement must still be
    // able to learn it.
    await invoke(harness, (ctx) => ctx.spawnAgentSession({ harness: 'claude', prompt: 'seed' }), {
      operations: crashingOperationsRepository(harness.fixture.operations, {
        stages: ['seed_submitted'],
      }),
    });
    const operation = (
      await run(harness.fixture.operations.listForExecution(harness.identity.executionId))
    )[0]!;
    assert.equal(operation.settledAt, null, 'nothing settled');

    const stages = transitions(harness)
      .filter((row) => row.operation_id === operation.id)
      .map((row) => JSON.parse(row.detail_inline ?? '{}').stage)
      .filter((stage): stage is string => typeof stage === 'string');
    assert.ok(stages.includes('session_created'));
    assert.ok(stages.includes('seed_submitting'));
    assert.ok(!stages.includes('seed_submitted'), 'the crash landed before that write');
  } finally {
    harness.close();
  }
});

test('a stop is its own recorded fact, separate from the operation it belongs to', async () => {
  const harness = await makeOperationHarness();
  try {
    harness.state.launchOutcomes = [{ kind: 'spawn_failed', cause: 'listener threw' }];
    await invoke(harness, (ctx) => ctx.runHeadlessAgent(prompt));
    const operation = (
      await run(harness.fixture.operations.listForExecution(harness.identity.executionId))
    )[0]!;

    const own = transitions(harness).filter((row) => row.operation_id === operation.id);
    const stop = own.filter((row) => row.kind === 'stop_recorded');
    assert.equal(stop.length, 1);
    const detail = JSON.parse(stop[0]!.detail_inline ?? '{}');
    assert.equal(detail.stopState, 'confirmed');
    // Ordered after the settlement, and carried separately from it: the operation failing and its
    // process being stopped are two facts, and a reader must be able to see both.
    const settlement = own.findIndex((row) => row.kind === 'operation_settled');
    assert.ok(settlement >= 0);
    assert.ok(own.indexOf(stop[0]!) > settlement);
  } finally {
    harness.close();
  }
});

test('operation identity changes with the execution, and history says which visit did what', async () => {
  const harness = await makeOperationHarness();
  try {
    const first = await invoke(harness, (ctx) => ctx.runHeadlessAgent(prompt));
    const firstKey = (first as { value: { operationId: string } }).value.operationId;
    const revisit = await harness.nextVisit();

    const built = await harness.service();
    let secondKey = '';
    try {
      const outcome = await runCallback(
        built.service.withAttemptContext(revisit, (ctx) =>
          Effect.tryPromise({ try: () => ctx.runHeadlessAgent(prompt), catch: (c) => c }),
        ),
      );
      secondKey = outcome.value.operationId;
    } finally {
      await built.close();
    }

    // The same authored call, the same request, a new visit. Reuse is scoped to
    // `(executionId, callIndex)`, so a revisit is new work and really performs its effect again —
    // anything else would silently turn a bounded retry loop into a single attempt.
    assert.notEqual(secondKey, firstKey);
    assert.equal(harness.state.counters.allocations, 2);
    assert.equal(harness.state.counters.starts, 2);

    const firstOperation = (await run(harness.fixture.operations.findByKey(firstKey)))!;
    const secondOperation = (await run(harness.fixture.operations.findByKey(secondKey)))!;
    assert.equal(firstOperation.callIndex, 0);
    assert.equal(secondOperation.callIndex, 0, 'call positions are per execution, not per run');
    assert.notEqual(secondOperation.executionId, firstOperation.executionId);
    assert.equal(secondOperation.executionId, revisit.executionId);

    const byExecution = transitions(harness).filter((row) => row.operation_id !== null);
    assert.ok(
      byExecution.some((row) => row.execution_id === harness.identity.executionId),
      'the first visit is attributable',
    );
    assert.ok(
      byExecution.some((row) => row.execution_id === revisit.executionId),
      'and so is the second, distinctly',
    );
  } finally {
    harness.close();
  }
});

async function settled(harness: OperationHarness, key: string, within = 2_000) {
  const deadline = Date.now() + within;
  for (;;) {
    const record = await run(harness.fixture.operations.findByKey(key));
    if (record?.settledAt) return record;
    if (Date.now() > deadline) throw new Error(`operation ${key} did not settle`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
