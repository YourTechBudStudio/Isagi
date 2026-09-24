import assert from 'node:assert/strict';
import test from 'node:test';

import type { OperationContext } from '@yourtechbudstudio/isagi-workflow-sdk';
import { Effect } from 'effect';

import { inlinePayloadThresholdBytes } from '../persistence/payload-store.js';
import type { WorkflowOperationRecord } from '../persistence/records.js';
import {
  crashingOperationsRepository,
  makeOperationHarness,
  run,
  runCallback,
  type OperationHarness,
} from './test-support.js';

const prompt = { harness: 'claude' as const, prompt: 'judge this' };

async function settledWithin(
  harness: OperationHarness,
  operationKey: string,
  timeoutMs = 2_000,
): Promise<WorkflowOperationRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = await run(harness.fixture.operations.findByKey(operationKey));
    if (record && record.settledAt !== null) return record;
    if (Date.now() > deadline) {
      throw new Error(`operation ${operationKey} did not settle within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function revisionCount(harness: OperationHarness): number {
  const row = harness.fixture.client
    .prepare(`SELECT COUNT(*) AS total FROM workflow_transitions WHERE run_id = ?`)
    .get(harness.identity.runId) as { total: number };
  return row.total;
}

async function lateEvidenceWithin(
  harness: OperationHarness,
  operationKey: string,
  timeoutMs = 2_000,
): Promise<WorkflowOperationRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = await run(harness.fixture.operations.findByKey(operationKey));
    if (record && record.lateEvidence !== null) return record;
    if (Date.now() > deadline) {
      throw new Error(`operation ${operationKey} recorded no late evidence within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function withLiveService<A>(
  harness: OperationHarness,
  body: (input: {
    readonly service: Awaited<ReturnType<OperationHarness['service']>>['service'];
    readonly bus: Awaited<ReturnType<OperationHarness['service']>>['bus'];
    readonly invoke: <B>(callback: (ctx: OperationContext) => Promise<B>) => Promise<B>;
  }) => Promise<A>,
  options?: Parameters<OperationHarness['service']>[0],
): Promise<A> {
  const built = await harness.service(options ?? {});
  try {
    return await body({
      service: built.service,
      bus: built.bus,
      invoke: async (callback) => {
        const outcome = await runCallback(
          built.service.withAttemptContext(harness.identity, (ctx) =>
            Effect.tryPromise({ try: () => callback(ctx), catch: (cause) => cause }),
          ),
        );
        return outcome.value;
      },
    });
  } finally {
    await built.close();
  }
}

test('a settlement is committed and visible to another reader before it is announced', async () => {
  const harness = await makeOperationHarness();
  try {
    await withLiveService(harness, async ({ bus, invoke }) => {
      const handle = await invoke((ctx) => ctx.runHeadlessAgent(prompt));
      const record = (await run(harness.fixture.operations.findByKey(handle.operationId)))!;
      harness.state.capturedOutput.set(record.ptyProcessId!, {
        raw: 'the judgment',
        output: 'the judgment',
      });

      await Effect.runPromise(
        bus.publish({
          type: 'pty_process_exited',
          status: 'exited',
          ptyProcessId: record.ptyProcessId!,
          exitCode: 0,
          signal: null,
        }),
      );

      const settled = await settledWithin(harness, handle.operationId);
      assert.equal(settled.state, 'completed');
      const result = (await run(harness.fixture.payloads.resolve(settled.result!))) as Record<
        string,
        unknown
      >;
      assert.equal(result.output, 'the judgment');
      assert.equal(result.operationId, handle.operationId);

      // The ordering claim, checked rather than asserted in prose. The observation was taken through
      // a *separate* connection at the moment of publication; the writing connection could have seen
      // its own uncommitted row, so only this proves the commit had landed. A subscriber woken by
      // the notification can never find a row that is not there.
      const observation = harness.publishObservations.find(
        (entry) => entry.operationId === settled.id,
      );
      assert.ok(observation, 'the settlement was announced');
      assert.equal(observation!.state, 'completed');
      assert.ok(
        observation!.settledAt,
        'and it was already committed when the announcement went out',
      );
    });
  } finally {
    harness.close();
  }
});

test('a settlement that never commits is never announced', async () => {
  const harness = await makeOperationHarness();
  try {
    const built = await harness.service({
      operations: crashingOperationsRepository(harness.fixture.operations, { onSettle: true }),
    });
    try {
      const handle = (
        await runCallback(
          built.service.withAttemptContext(harness.identity, (ctx) =>
            Effect.tryPromise({ try: () => ctx.runHeadlessAgent(prompt), catch: (c) => c }),
          ),
        )
      ).value;
      const record = (await run(harness.fixture.operations.findByKey(handle.operationId)))!;

      await Effect.runPromise(
        built.bus.publish({
          type: 'pty_process_exited',
          status: 'exited',
          ptyProcessId: record.ptyProcessId!,
          exitCode: 0,
          signal: null,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));

      // The settlement transaction rolled back, so there is nothing to announce. Publishing anyway
      // would send a client looking for a state that does not exist and never will.
      const unchanged = (await run(harness.fixture.operations.findByKey(handle.operationId)))!;
      assert.equal(unchanged.state, 'dispatched');
      assert.equal(unchanged.settledAt, null);
      assert.equal(
        harness.events.filter((event) => event.type === 'workflow_operation_settled').length,
        0,
      );
      assert.equal(harness.publishObservations.length, 0);
    } finally {
      await built.close();
    }
  } finally {
    harness.close();
  }
});

test('a non-zero exit settles failed and keeps whatever output it produced', async () => {
  const harness = await makeOperationHarness();
  try {
    await withLiveService(harness, async ({ bus, invoke }) => {
      const handle = await invoke((ctx) => ctx.runHeadlessAgent(prompt));
      const record = (await run(harness.fixture.operations.findByKey(handle.operationId)))!;
      harness.state.capturedOutput.set(record.ptyProcessId!, { raw: 'partial', output: 'partial' });

      await Effect.runPromise(
        bus.publish({
          type: 'pty_process_exited',
          status: 'exited',
          ptyProcessId: record.ptyProcessId!,
          exitCode: 2,
          signal: null,
        }),
      );

      const settled = await settledWithin(harness, handle.operationId);
      assert.equal(settled.state, 'failed');
      const result = (await run(harness.fixture.payloads.resolve(settled.result!))) as Record<
        string,
        unknown
      >;
      assert.equal(result.error, 'non_zero_exit');
      assert.equal(result.exitCode, 2);
      assert.equal(result.output, 'partial');
    });
  } finally {
    harness.close();
  }
});

test('a second terminal for an already settled operation changes nothing', async () => {
  const harness = await makeOperationHarness();
  try {
    await withLiveService(harness, async ({ bus, invoke }) => {
      const handle = await invoke((ctx) => ctx.runHeadlessAgent(prompt));
      const record = (await run(harness.fixture.operations.findByKey(handle.operationId)))!;
      await Effect.runPromise(
        bus.publish({
          type: 'pty_process_exited',
          status: 'exited',
          ptyProcessId: record.ptyProcessId!,
          exitCode: 0,
          signal: null,
        }),
      );
      const first = await settledWithin(harness, handle.operationId);

      await Effect.runPromise(
        bus.publish({
          type: 'pty_process_killed',
          status: 'killed',
          statusReason: null,
          ptyProcessId: record.ptyProcessId!,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));

      const again = (await run(harness.fixture.operations.findByKey(handle.operationId)))!;
      assert.equal(again.state, first.state);
      assert.equal(again.settledAt, first.settledAt, 'an outcome is recorded once');
      assert.equal(again.lateEvidence, null, 'and nothing was filed as late evidence either');
    });
  } finally {
    harness.close();
  }
});

test('one committed member survives while only the owner-lost member is interrupted', async () => {
  const harness = await makeOperationHarness();
  try {
    let keys: readonly string[] = [];
    await withLiveService(
      harness,
      async ({ bus, invoke }) => {
        const handles = await invoke(async (ctx) => [
          await ctx.runHeadlessAgent({ ...prompt, prompt: 'A' }),
          await ctx.runHeadlessAgent({ ...prompt, prompt: 'B' }),
        ]);
        keys = handles.map((handle) => handle.operationId);
        const first = (await run(harness.fixture.operations.findByKey(keys[0]!)))!;
        harness.state.capturedOutput.set(first.ptyProcessId!, { raw: 'A done', output: 'A done' });
        await Effect.runPromise(
          bus.publish({
            type: 'pty_process_exited',
            status: 'exited',
            ptyProcessId: first.ptyProcessId!,
            exitCode: 0,
            signal: null,
          }),
        );
        await settledWithin(harness, keys[0]!);
      },
      { incarnationId: 'incarnation-a' },
    );

    // A restart. Only the member that lost its capture owner is interrupted; the committed one is
    // retained exactly as it was, because a result that exists is not improved by re-deriving it.
    const built = await harness.service({ incarnationId: 'incarnation-b' });
    try {
      await Effect.runPromise(built.service.reconcileExecution(harness.identity.executionId));
    } finally {
      await built.close();
    }

    const completed = (await run(harness.fixture.operations.findByKey(keys[0]!)))!;
    const interrupted = (await run(harness.fixture.operations.findByKey(keys[1]!)))!;
    assert.equal(completed.state, 'completed');
    assert.equal(
      ((await run(harness.fixture.payloads.resolve(completed.result!))) as { output: string })
        .output,
      'A done',
    );
    assert.equal(interrupted.state, 'interrupted');
  } finally {
    harness.close();
  }
});

test('a late terminal is kept as evidence and never rewrites the outcome', async () => {
  const harness = await makeOperationHarness();
  try {
    let key = '';
    await withLiveService(
      harness,
      async ({ invoke }) => {
        const handle = await invoke((ctx) => ctx.runHeadlessAgent(prompt));
        key = handle.operationId;
      },
      { incarnationId: 'incarnation-a' },
    );

    const built = await harness.service({ incarnationId: 'incarnation-b' });
    try {
      await Effect.runPromise(built.service.reconcileExecution(harness.identity.executionId));
      const interrupted = (await run(harness.fixture.operations.findByKey(key)))!;
      assert.equal(interrupted.state, 'interrupted');
      assert.equal(interrupted.lateEvidence, null);

      // A process that survived the incarnation which was capturing it, finally finishing. This is
      // the only record of what that agent actually did in the person's worktree; the capture
      // lifecycle is fenced to the old incarnation, so it is evidence and never a revival.
      harness.state.capturedOutput.set(interrupted.ptyProcessId!, {
        raw: 'the work it finished anyway',
        output: 'the work it finished anyway',
      });
      await Effect.runPromise(
        built.bus.publish({
          type: 'pty_process_exited',
          status: 'exited',
          ptyProcessId: interrupted.ptyProcessId!,
          exitCode: 0,
          signal: null,
        }),
      );
      const withEvidence = await lateEvidenceWithin(harness, key);

      // Settlement facts are untouched.
      assert.equal(withEvidence.state, 'interrupted');
      assert.equal(withEvidence.settledAt, interrupted.settledAt);
      assert.deepEqual(withEvidence.result, interrupted.result);

      const evidence = (await run(
        harness.fixture.payloads.resolve(withEvidence.lateEvidence!),
      )) as { reason: string; result: Record<string, unknown> };
      assert.equal(evidence.reason, 'late_process_terminal');
      assert.equal(evidence.result.status, 'completed');
      assert.equal(evidence.result.output, 'the work it finished anyway');
      assert.equal(evidence.result.exitCode, 0);
    } finally {
      await built.close();
    }
  } finally {
    harness.close();
  }
});

test('an identical repeat of a late terminal is inert and allocates no revision', async () => {
  const harness = await makeOperationHarness();
  try {
    let key = '';
    await withLiveService(
      harness,
      async ({ invoke }) => {
        const handle = await invoke((ctx) => ctx.runHeadlessAgent(prompt));
        key = handle.operationId;
      },
      { incarnationId: 'incarnation-a' },
    );

    const built = await harness.service({ incarnationId: 'incarnation-b' });
    try {
      await Effect.runPromise(built.service.reconcileExecution(harness.identity.executionId));
      const interrupted = (await run(harness.fixture.operations.findByKey(key)))!;
      const terminal = {
        type: 'pty_process_exited' as const,
        status: 'exited' as const,
        ptyProcessId: interrupted.ptyProcessId!,
        exitCode: 0,
        signal: null,
      };
      await Effect.runPromise(built.bus.publish(terminal));
      const first = await lateEvidenceWithin(harness, key);
      const revisionsAfterFirst = revisionCount(harness);

      await Effect.runPromise(built.bus.publish(terminal));
      await new Promise((resolve) => setTimeout(resolve, 50));

      const again = (await run(harness.fixture.operations.findByKey(key)))!;
      assert.deepEqual(again.lateEvidence, first.lateEvidence, 'the first observation stands');
      // A client walking history must not be handed the same fact twice.
      assert.equal(revisionCount(harness), revisionsAfterFirst);
    } finally {
      await built.close();
    }
  } finally {
    harness.close();
  }
});

test('a duplicate terminal after an observed result creates no redundant late evidence', async () => {
  const harness = await makeOperationHarness();
  try {
    await withLiveService(harness, async ({ bus, invoke }) => {
      const handle = await invoke((ctx) => ctx.runHeadlessAgent(prompt));
      const record = (await run(harness.fixture.operations.findByKey(handle.operationId)))!;
      const terminal = {
        type: 'pty_process_exited' as const,
        status: 'exited' as const,
        ptyProcessId: record.ptyProcessId!,
        exitCode: 0,
        signal: null,
      };
      await Effect.runPromise(bus.publish(terminal));
      await settledWithin(harness, handle.operationId);

      // The settlement already describes this terminal, because we watched it happen. Seeing it a
      // second time adds nothing, and recording it would clutter the operation with a duplicate of
      // its own result.
      await Effect.runPromise(bus.publish(terminal));
      await new Promise((resolve) => setTimeout(resolve, 50));

      const settled = (await run(harness.fixture.operations.findByKey(handle.operationId)))!;
      assert.equal(settled.state, 'completed');
      assert.equal(settled.lateEvidence, null);
    });
  } finally {
    harness.close();
  }
});

test('late evidence too large to inline round-trips through its payload reference', async () => {
  const harness = await makeOperationHarness();
  try {
    let key = '';
    await withLiveService(
      harness,
      async ({ invoke }) => {
        const handle = await invoke((ctx) => ctx.runHeadlessAgent(prompt));
        key = handle.operationId;
      },
      { incarnationId: 'incarnation-a' },
    );

    const built = await harness.service({ incarnationId: 'incarnation-b' });
    try {
      await Effect.runPromise(built.service.reconcileExecution(harness.identity.executionId));
      const interrupted = (await run(harness.fixture.operations.findByKey(key)))!;
      // An agent's real output is exactly the thing that will not fit inline.
      const large = 'x'.repeat(inlinePayloadThresholdBytes + 1_024);
      harness.state.capturedOutput.set(interrupted.ptyProcessId!, { raw: large, output: large });
      await Effect.runPromise(
        built.bus.publish({
          type: 'pty_process_exited',
          status: 'exited',
          ptyProcessId: interrupted.ptyProcessId!,
          exitCode: 0,
          signal: null,
        }),
      );
      const withEvidence = await lateEvidenceWithin(harness, key);

      assert.equal(withEvidence.lateEvidence?.inline, null, 'stored by reference, not inline');
      assert.ok(withEvidence.lateEvidence?.ref);
      const evidence = (await run(
        harness.fixture.payloads.resolve(withEvidence.lateEvidence!),
      )) as { result: { output: string } };
      assert.equal(evidence.result.output, large);
      assert.equal(withEvidence.state, 'interrupted', 'and the settlement is still untouched');
    } finally {
      await built.close();
    }
  } finally {
    harness.close();
  }
});

test('an operation that outruns its effective timeout fails and asks for its process to stop', async () => {
  const harness = await makeOperationHarness();
  try {
    await withLiveService(harness, async ({ invoke }) => {
      const handle = await invoke((ctx) => ctx.runHeadlessAgent({ ...prompt, timeoutMs: 20 }));
      const settled = await settledWithin(harness, handle.operationId);
      assert.equal(settled.state, 'failed');
      const result = (await run(harness.fixture.payloads.resolve(settled.result!))) as Record<
        string,
        unknown
      >;
      assert.equal(result.error, 'timeout');
      assert.equal(harness.state.counters.terminations, 1);
    });
  } finally {
    harness.close();
  }
});

test('a resumed operation keeps the timeout it was created with, not a changed default', async () => {
  const harness = await makeOperationHarness();
  try {
    // A crash before the marker that precedes `start`, so the position is redispatchable and the
    // author never supplied a timeout — the exact shape where a changed runtime default could
    // silently re-scope an operation nobody touched.
    const built = await harness.service({
      incarnationId: 'incarnation-a',
      operations: crashingOperationsRepository(harness.fixture.operations, {
        stages: ['starting'],
      }),
    });
    try {
      await runCallback(
        built.service.withAttemptContext(harness.identity, (ctx) =>
          Effect.tryPromise({ try: () => ctx.runHeadlessAgent(prompt), catch: (c) => c }),
        ),
      ).catch(() => undefined);
    } finally {
      await built.close();
    }

    const recorded = (
      await run(harness.fixture.operations.listForExecution(harness.identity.executionId))
    )[0]!;
    const envelope = (await run(harness.fixture.payloads.resolve(recorded.request!))) as {
      request: Record<string, unknown>;
      dispatch: { effectiveTimeoutMs: number } | null;
    };
    // The author asked for nothing; the runtime resolved a default and recorded it *outside* the
    // fingerprint. Both facts are durable and only one of them is identity.
    assert.equal(envelope.request.timeoutMs, null);
    assert.equal(envelope.dispatch?.effectiveTimeoutMs, 600_000);

    const fingerprintBefore = recorded.requestFingerprint;
    await run(harness.fixture.operations.settle({ operationId: recorded.id, state: 'abandoned' }));

    const resumed = await harness.service({ incarnationId: 'incarnation-b' });
    try {
      await runCallback(
        resumed.service.withAttemptContext(harness.identity, (ctx) =>
          Effect.tryPromise({ try: () => ctx.runHeadlessAgent(prompt), catch: (c) => c }),
        ),
      );
    } finally {
      await resumed.close();
    }

    const after = (await run(harness.fixture.operations.findById(recorded.id)))!;
    assert.equal(after.requestFingerprint, fingerprintBefore, 'identity is unchanged');
    const afterEnvelope = (await run(harness.fixture.payloads.resolve(after.request!))) as {
      dispatch: { effectiveTimeoutMs: number } | null;
    };
    assert.equal(
      afterEnvelope.dispatch?.effectiveTimeoutMs,
      600_000,
      'the redispatch kept the configuration the operation was created with',
    );
  } finally {
    harness.close();
  }
});
