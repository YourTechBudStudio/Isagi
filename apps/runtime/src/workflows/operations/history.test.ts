import assert from 'node:assert/strict';
import test from 'node:test';

import type { OperationContext } from '@yourtechbudstudio/isagi-workflow-sdk';
import { Effect } from 'effect';

import {
  crashingOperationsRepository,
  makeOperationHarness,
  run,
  runCallback,
  RUNTIME,
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

/**
 * Criterion 6: every operation records who ran it, where, and with what.
 *
 * The distinctions being asserted are the ones that would be invisible if provenance were guessed
 * from the run rather than recorded per operation. A send's `cwd` is the *session's*, not the run
 * destination's, because a send runs where the session it targets runs. Its model and effort are
 * `null` rather than the spawn's values, because the session's spawn settings apply and are not
 * knowable at the call site — recording a guess there would make a wrong answer indistinguishable
 * from a right one.
 */
test('a send records the session it targets, not the run it belongs to', async () => {
  const harness = await makeOperationHarness();
  try {
    harness.state.sessionHarness = 'codex';
    harness.state.sessionCwd = '/repo/some-other-place';
    await invoke(harness, (ctx) => ctx.sendAgentPrompt({ agentSessionId: 42, prompt: 'go' }));

    const [operation] = await run(
      harness.fixture.operations.listForExecution(harness.identity.executionId),
    );
    assert.ok(operation);
    assert.equal(operation.harness, 'codex');
    assert.equal(operation.cwd, '/repo/some-other-place');
    assert.notEqual(
      operation.cwd,
      harness.identity.destination.worktreePath,
      'A send must not borrow the run destination as its working directory.',
    );
    assert.equal(operation.model, null);
    assert.equal(operation.effort, null);
    assert.equal(operation.runtimeId, RUNTIME);
    assert.ok(operation.incarnationId);
    // The submission's turn, correlated by watermark once the turn is observed.
    assert.equal(operation.attribution, 'not_applicable');
    // Nothing reported usage: a PTY submission has no provider result to read one from.
    assert.equal(operation.usage, null);
  } finally {
    harness.close();
  }
});

test('a spawn records what it was asked to launch, in the run destination', async () => {
  const harness = await makeOperationHarness();
  try {
    await invoke(harness, (ctx) =>
      ctx.spawnAgentSession({
        harness: 'claude',
        prompt: 'seed',
        model: 'claude-opus-5',
        effort: 'high',
      }),
    );

    const [operation] = await run(
      harness.fixture.operations.listForExecution(harness.identity.executionId),
    );
    assert.ok(operation);
    assert.equal(operation.harness, 'claude');
    assert.equal(operation.model, 'claude-opus-5');
    assert.equal(operation.effort, 'high');
    assert.equal(operation.cwd, harness.identity.destination.worktreePath);
    assert.equal(operation.runtimeId, RUNTIME);
  } finally {
    harness.close();
  }
});

/**
 * A headless run learns two things only once the process has finished saying what it did.
 *
 * `correlated_harness_session_id` is written at settlement while `attribution` stays
 * `not_applicable`, and that pairing is accurate rather than an oversight: the provider *told* us
 * the id, so nothing was inferred by watermark. Attribution describes how a turn was matched, not
 * whether one is known.
 */
test('a headless settlement records the session id and usage the provider reported', async () => {
  const harness = await makeOperationHarness();
  try {
    harness.state.headlessProvenance = {
      harnessSessionId: 'claude-session-abc',
      usage: {
        inputTokens: 2,
        cacheReadInputTokens: 10118,
        cacheCreationInputTokens: 10019,
        outputTokens: 4,
        costUsd: 0.105359,
      },
    };
    // Driven to a real settlement rather than through `invoke`: these two facts are written *at*
    // settlement, so an operation that never finished would have nothing to assert.
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
    assert.equal(operation.state, 'completed');
    assert.equal(operation.harness, 'claude');
    assert.equal(operation.cwd, harness.identity.destination.worktreePath);
    assert.equal(operation.correlatedHarnessSessionId, 'claude-session-abc');
    assert.equal(operation.attribution, 'not_applicable');
    // All five counts survive the round trip through `usage_json`, uncomputed. `inputTokens` is the
    // bare uncached input and is meant to look small beside the cache counts.
    assert.deepEqual(operation.usage, {
      inputTokens: 2,
      cacheReadInputTokens: 10118,
      cacheCreationInputTokens: 10019,
      outputTokens: 4,
      costUsd: 0.105359,
    });
  } finally {
    harness.close();
  }
});

/**
 * An operation recorded before these columns existed must read as *unknown*, not as anything else.
 *
 * This is the honest-behaviour half of criterion 6. A seeded pre-migration row is simulated here by
 * clearing the columns directly, because that is exactly the state the `0012` migration leaves
 * every historical row in.
 */
test('an operation with no recorded provenance reads back as explicitly unknown', async () => {
  const harness = await makeOperationHarness();
  try {
    await invoke(harness, (ctx) => ctx.runHeadlessAgent(prompt));
    const [recorded] = await run(
      harness.fixture.operations.listForExecution(harness.identity.executionId),
    );
    assert.ok(recorded);

    harness.fixture.client
      .prepare(
        `UPDATE workflow_operations
            SET harness = NULL, model = NULL, effort = NULL, cwd = NULL,
                runtime_id = NULL, incarnation_id = NULL, usage_json = NULL
          WHERE id = ?`,
      )
      .run(recorded.id);

    const operation = (await run(harness.fixture.operations.findById(recorded.id)))!;
    assert.deepEqual(
      {
        harness: operation.harness,
        model: operation.model,
        effort: operation.effort,
        cwd: operation.cwd,
        runtimeId: operation.runtimeId,
        incarnationId: operation.incarnationId,
        usage: operation.usage,
      },
      {
        harness: null,
        model: null,
        effort: null,
        cwd: null,
        runtimeId: null,
        incarnationId: null,
        usage: null,
      },
    );
  } finally {
    harness.close();
  }
});

/** Unparsable usage is unknown usage. A half-read record would be worse than none. */
test('usage that does not parse reads as no usage at all', async () => {
  const harness = await makeOperationHarness();
  try {
    await invoke(harness, (ctx) => ctx.runHeadlessAgent(prompt));
    const [recorded] = await run(
      harness.fixture.operations.listForExecution(harness.identity.executionId),
    );
    assert.ok(recorded);
    harness.fixture.client
      .prepare(`UPDATE workflow_operations SET usage_json = ? WHERE id = ?`)
      .run('{ not json', recorded.id);
    assert.equal((await run(harness.fixture.operations.findById(recorded.id)))!.usage, null);
  } finally {
    harness.close();
  }
});
