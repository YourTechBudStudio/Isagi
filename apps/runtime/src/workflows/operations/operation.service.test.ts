import assert from 'node:assert/strict';
import test from 'node:test';

import type { OperationContext } from '@yourtechbudstudio/isagi-workflow-sdk';
import { Effect } from 'effect';

import { OperationRejection } from './errors.js';
import { makeOperationHarness, run, runCallback, type OperationHarness } from './test-support.js';

/**
 * Runs a callback through a live context, the way the interpreter will.
 *
 * An author callback is plain async TypeScript, so its rejection arrives as a promise rejection and
 * has to be carried into the failure channel rather than becoming a defect — that is the shape phase
 * 04 has to map into a segment failure, and a test that let it become a defect would be asserting
 * against a different path.
 */
async function invoke<A>(
  harness: OperationHarness,
  callback: (ctx: OperationContext) => Promise<A>,
  options?: { readonly incarnationId?: string },
) {
  const built = await harness.service(options ?? {});
  try {
    return await runCallback(
      built.service.withAttemptContext(harness.identity, (ctx) =>
        Effect.tryPromise({ try: () => callback(ctx), catch: (cause) => cause }),
      ),
    );
  } finally {
    await built.close();
  }
}

async function captureRejection(body: () => Promise<unknown>): Promise<OperationRejection> {
  try {
    await body();
  } catch (cause) {
    const rejection = unwrapRejection(cause);
    if (rejection) return rejection;
    throw cause;
  }
  throw new Error('expected the callback to reject');
}

/**
 * Walk to the real rejection.
 *
 * A verb rejects with the `OperationRejection` itself — that is the contract author code relies on —
 * but a test that drives the verb through an outer Effect sees that promise rejection re-wrapped once
 * by the harness's own `Effect.promise`. Unwrapping here keeps the assertions about the author-facing
 * error rather than about the plumbing around it.
 */
function unwrapRejection(cause: unknown): OperationRejection | null {
  if (cause instanceof OperationRejection) return cause;
  const nested = (cause as { readonly cause?: unknown })?.cause;
  return nested === undefined || nested === null ? null : unwrapRejection(nested);
}

const prompt = { harness: 'claude' as const, prompt: 'judge this' };

test('a fresh callback dispatches once and records a settled call position', async () => {
  const harness = await makeOperationHarness();
  try {
    const outcome = await invoke(harness, async (ctx) => ctx.runHeadlessAgent(prompt));
    assert.equal(harness.state.counters.allocations, 1);
    assert.equal(harness.state.counters.starts, 1);
    assert.equal(outcome.consumedCallCount, 1);
    assert.equal(outcome.recordedCallCount, 1);

    const recorded = await run(
      harness.fixture.operations.listForExecution(harness.identity.executionId),
    );
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.callIndex, 0);
    assert.equal(recorded[0]!.state, 'dispatched');
    assert.equal(recorded[0]!.stage, 'started');
    assert.equal(recorded[0]!.operationKey, outcome.value.operationId);
  } finally {
    harness.close();
  }
});

test('re-entering the same callback reuses the receipt and dispatches nothing', async () => {
  const harness = await makeOperationHarness();
  try {
    const first = await invoke(harness, async (ctx) => ctx.runHeadlessAgent(prompt));
    const second = await invoke(harness, async (ctx) => ctx.runHeadlessAgent(prompt));

    assert.equal(harness.state.counters.allocations, 1, 'a reused receipt allocates nothing');
    assert.equal(harness.state.counters.starts, 1);
    assert.equal(second.value.operationId, first.value.operationId);
  } finally {
    harness.close();
  }
});

test('inserting a call before a recorded one fails before the new effect is sent', async () => {
  const harness = await makeOperationHarness();
  try {
    await invoke(harness, async (ctx) => ctx.runHeadlessAgent({ ...prompt, prompt: 'A' }));
    assert.equal(harness.state.counters.allocations, 1);

    const rejection = await captureRejection(() =>
      invoke(harness, async (ctx) => {
        await ctx.runHeadlessAgent({ ...prompt, prompt: 'B' });
        await ctx.runHeadlessAgent({ ...prompt, prompt: 'A' });
      }),
    );
    assert.equal(rejection.code, 'operation_request_changed');
    // The decisive assertion: B never reached a boundary. A rejection after dispatch would have
    // started a second agent in the person's worktree before reporting the incompatibility.
    assert.equal(harness.state.counters.allocations, 1);
  } finally {
    harness.close();
  }
});

test('omitting a recorded call is reported as an unconsumed prefix rather than silently abandoned', async () => {
  const harness = await makeOperationHarness();
  try {
    await invoke(harness, async (ctx) => {
      await ctx.runHeadlessAgent({ ...prompt, prompt: 'A' });
      await ctx.runHeadlessAgent({ ...prompt, prompt: 'B' });
    });
    assert.equal(harness.state.counters.allocations, 2);

    const outcome = await invoke(harness, async (ctx) =>
      ctx.runHeadlessAgent({ ...prompt, prompt: 'A' }),
    );
    // Reported, not thrown: phase 04 turns the mismatch into a segment failure. What this layer owes
    // is an honest count of how far the invocation walked versus how far the record goes.
    assert.equal(outcome.consumedCallCount, 1);
    assert.equal(outcome.recordedCallCount, 2);
    assert.equal(harness.state.counters.allocations, 2);
  } finally {
    harness.close();
  }
});

test('restoring a call and discarding its value succeeds with no further dispatch', async () => {
  const harness = await makeOperationHarness();
  try {
    await invoke(harness, async (ctx) => {
      await ctx.runHeadlessAgent({ ...prompt, prompt: 'A' });
      await ctx.runHeadlessAgent({ ...prompt, prompt: 'B' });
    });

    // The documented escape hatch: keep the call at the same position with the same request and
    // throw the handle away. The prefix is accounted for and the revised pure logic proceeds.
    const outcome = await invoke(harness, async (ctx) => {
      void (await ctx.runHeadlessAgent({ ...prompt, prompt: 'A' }));
      const b = await ctx.runHeadlessAgent({ ...prompt, prompt: 'B' });
      return b.operationId;
    });
    assert.equal(outcome.consumedCallCount, 2);
    assert.equal(outcome.recordedCallCount, 2);
    assert.equal(harness.state.counters.allocations, 2, 'no additional external dispatch');
  } finally {
    harness.close();
  }
});

test('adding only diagnostics does not shift any effect position', async () => {
  const harness = await makeOperationHarness();
  try {
    await invoke(harness, async (ctx) => ctx.runHeadlessAgent({ ...prompt, prompt: 'A' }));

    const outcome = await invoke(harness, async (ctx) => {
      await ctx.log('info', 'about to judge');
      await ctx.setUiFeedback({ phase: 'judging', message: 'working' });
      const handle = await ctx.runHeadlessAgent({ ...prompt, prompt: 'A' });
      await ctx.log('info', 'judged');
      return handle;
    });
    assert.equal(outcome.consumedCallCount, 1, 'diagnostics consume no call position');
    assert.equal(outcome.recordedCallCount, 1);
    assert.equal(harness.state.counters.allocations, 1);
  } finally {
    harness.close();
  }
});

test('a scoped read consumes no call position and may answer differently each time', async () => {
  const harness = await makeOperationHarness();
  try {
    const outcome = await invoke(harness, async (ctx) => {
      await ctx.getConversationHistory(500);
      await ctx.getConversationHistory(500);
      return ctx.runHeadlessAgent(prompt);
    });
    assert.equal(outcome.consumedCallCount, 1);
    assert.equal(outcome.recordedCallCount, 1);
  } finally {
    harness.close();
  }
});

test('two headless operations dispatch concurrently and keep distinct identities', async () => {
  const harness = await makeOperationHarness();
  try {
    const outcome = await invoke(harness, async (ctx) =>
      Promise.all([
        ctx.runHeadlessAgent({ ...prompt, prompt: 'A' }),
        ctx.runHeadlessAgent({ ...prompt, prompt: 'B' }),
      ]),
    );
    assert.equal(harness.state.counters.allocations, 2);
    assert.notEqual(outcome.value[0].operationId, outcome.value[1].operationId);
    assert.equal(outcome.consumedCallCount, 2);

    const recorded = await run(
      harness.fixture.operations.listForExecution(harness.identity.executionId),
    );
    assert.deepEqual(
      recorded.map((entry) => entry.callIndex),
      [0, 1],
      'call positions are allocated in call order even when the dispatches overlap',
    );
  } finally {
    harness.close();
  }
});

test('an earlier uncertain operation blocks a later call before it dispatches', async () => {
  const harness = await makeOperationHarness();
  try {
    const first = await invoke(harness, async (ctx) =>
      ctx.runHeadlessAgent({ ...prompt, prompt: 'A' }),
    );
    const record = (await run(harness.fixture.operations.findByKey(first.value.operationId)))!;
    await run(
      harness.fixture.operations.settle({
        operationId: record.id,
        state: 'uncertain',
        uncertaintyDetail: 'test',
      }),
    );

    const before = harness.state.counters.allocations;
    const rejection = await captureRejection(() =>
      invoke(harness, async (ctx) => {
        await ctx.runHeadlessAgent({ ...prompt, prompt: 'A' }).catch(() => undefined);
        return ctx.runHeadlessAgent({ ...prompt, prompt: 'B' });
      }),
    );
    assert.ok(
      rejection.code === 'operation_uncertain' || rejection.code === 'operation_prefix_unresolved',
    );
    assert.equal(harness.state.counters.allocations, before, 'nothing new crossed a boundary');
  } finally {
    harness.close();
  }
});

test('a verb reached after its attempt scope closes fails instead of acting on a finished segment', async () => {
  const harness = await makeOperationHarness();
  const built = await harness.service();
  try {
    let escaped: OperationContext | null = null;
    await runCallback(
      built.service.withAttemptContext(harness.identity, (ctx) =>
        Effect.sync(() => {
          escaped = ctx;
        }),
      ),
    );
    const rejection = await captureRejection(() => escaped!.runHeadlessAgent(prompt));
    assert.equal(rejection.code, 'operation_context_closed');
    assert.equal(harness.state.counters.allocations, 0);

    // Diagnostics are closed by the same gate, for the same reason: a segment that has committed its
    // result is not still running.
    const diagnostic = await captureRejection(() => escaped!.log('info', 'too late'));
    assert.equal(diagnostic.code, 'operation_context_closed');
  } finally {
    await built.close();
    harness.close();
  }
});

test('closing a callback context does not stop capture the service already owns', async () => {
  const harness = await makeOperationHarness();
  const built = await harness.service();
  try {
    const outcome = await runCallback(
      built.service.withAttemptContext(harness.identity, (ctx) =>
        Effect.tryPromise({ try: () => ctx.runHeadlessAgent(prompt), catch: (c) => c }),
      ),
    );
    // The callback is over and its verbs are closed, but the operation is still dispatched and its
    // capture is still the runtime's to finish. Tearing it down with the callback would lose the
    // result of work that is genuinely still running.
    const record = (await run(harness.fixture.operations.findByKey(outcome.value.operationId)))!;
    assert.equal(record.state, 'dispatched');
    assert.equal(record.stage, 'started');
    assert.equal(record.captureOwner, built.service.incarnationId);
  } finally {
    await built.close();
    harness.close();
  }
});

test('a diagnostic that cannot be recorded fails the call rather than vanishing', async () => {
  const harness = await makeOperationHarness();
  try {
    // A run that does not exist is the reachable shape of "the diagnostic write was rejected".
    const built = await harness.service();
    try {
      const rejection = await captureRejection(() =>
        runCallback(
          built.service.withAttemptContext(
            { ...harness.identity, runId: harness.identity.runId + 9_999 },
            (ctx) => Effect.tryPromise({ try: () => ctx.log('info', 'orphan'), catch: (c) => c }),
          ),
        ),
      );
      assert.equal(rejection.code, 'workflow_operation_failed');
    } finally {
      await built.close();
    }
  } finally {
    harness.close();
  }
});

test('a diagnostic written before a failure is retained, and correlated to its attempt', async () => {
  const harness = await makeOperationHarness();
  try {
    await captureRejection(() =>
      invoke(harness, async (ctx) => {
        await ctx.log('warning', 'about to fail');
        throw new OperationRejection({ code: 'workflow_operation_failed', message: 'boom' });
      }),
    ).catch(() => undefined);

    const logs = harness.fixture.client
      .prepare(
        `SELECT kind, attempt_id FROM workflow_transitions WHERE run_id = ? AND kind = 'log'`,
      )
      .all(harness.identity.runId) as { kind: string; attempt_id: number }[];
    assert.equal(logs.length, 1, 'a diagnostic written before a failure survives it');
    assert.equal(
      logs[0]!.attempt_id,
      harness.identity.attemptId,
      'a diagnostic belongs to the attempt that wrote it',
    );
  } finally {
    harness.close();
  }
});

test('supplied modifiers survive persistence and receipt reuse, and do not decide identity', async () => {
  const harness = await makeOperationHarness();
  try {
    const modifiers = [{ kind: 'skill' as const, name: 'review' }];
    const first = await invoke(harness, async (ctx) =>
      ctx.runHeadlessAgent({ ...prompt, modifiers }),
    );
    const record = (await run(harness.fixture.operations.findByKey(first.value.operationId)))!;
    const stored = (await run(harness.fixture.payloads.resolve(record.request!))) as {
      request: Record<string, unknown>;
      metadata: { modifiers: unknown } | null;
    };
    // What the author wrote, kept for the inspector, beside the request rather than inside it.
    assert.deepEqual(stored.metadata?.modifiers, modifiers);
    assert.equal('modifiers' in stored.request, false);

    // Re-entry reuses the receipt, and the metadata is still there afterwards — a recovery path that
    // adopted a recorded operation must not quietly drop what the inspector reads.
    const second = await invoke(harness, async (ctx) =>
      ctx.runHeadlessAgent({ ...prompt, modifiers }),
    );
    assert.equal(second.value.operationId, first.value.operationId);
    assert.equal(harness.state.counters.allocations, 1);
    const after = (await run(harness.fixture.operations.findByKey(first.value.operationId)))!;
    const reread = (await run(harness.fixture.payloads.resolve(after.request!))) as {
      metadata: { modifiers: unknown } | null;
    };
    assert.deepEqual(reread.metadata?.modifiers, modifiers);
  } finally {
    harness.close();
  }
});

test('metadata cannot make a genuinely changed request reuse an old receipt', async () => {
  const harness = await makeOperationHarness();
  try {
    // A modifier that changes what is actually sent changes the semantic request, and must be
    // refused at a recorded position like any other changed request. The point of keeping metadata
    // outside the fingerprint is that it carries no *extra* meaning — not that a different prompt
    // can slip through under the same identity.
    await invoke(harness, async (ctx) =>
      ctx.runHeadlessAgent({ ...prompt, modifiers: [{ kind: 'skill', name: 'review' }] }),
    );
    const before = harness.state.counters.allocations;

    const rejection = await captureRejection(() =>
      invoke(harness, async (ctx) =>
        ctx.runHeadlessAgent({ ...prompt, modifiers: [{ kind: 'skill', name: 'rewrite' }] }),
      ),
    );
    assert.equal(rejection.code, 'operation_request_changed');
    assert.equal(harness.state.counters.allocations, before, 'nothing new was dispatched');
  } finally {
    harness.close();
  }
});
