import assert from 'node:assert/strict';
import test from 'node:test';

import {
  complete,
  createGraph,
  defineWorkflow,
  edge,
  eventGuards,
  operation,
  outcome,
  reduce,
  suspend,
  wait,
  type HeadlessOperationResult,
} from '@yourtechbudstudio/isagi-workflow-sdk';
import { Effect } from 'effect';

import { run } from '../persistence/test-support.js';
import type { AnyWorkflowDefinition } from '../structure/loader.js';
import { makeEngineHarness, type EngineHarness } from './test-support.js';

/**
 * Durable operations, seen from the interpreter.
 *
 * Phase 03 established what an operation *settles* as; this file is about what the graph then does
 * with it — that a suspended visit resumes once its members settle, that a lost capture becomes one
 * interruption the author's edge can route on, and above all that a repaired segment does not
 * perform the effect again. Every claim is asserted on a dispatch counter, because a run that
 * finishes is not evidence that it finished without doing the work twice.
 */

async function withHarness(body: (harness: EngineHarness) => Promise<void>) {
  const harness = await makeEngineHarness();
  try {
    await body(harness);
  } finally {
    await harness.close();
  }
}

interface JudgeState {
  readonly attempts: number;
  readonly verdict: string | null;
  readonly interrupted: number;
}

/**
 * One headless judgment with a bounded retry route.
 *
 * The loop back to `judge` on an interruption is the author's own bounded failure route: a new
 * execution, a new operation, a genuinely new effect — never an automatic reissue of the one that
 * was lost.
 */
function judgingWorkflow(options: { readonly members?: number } = {}): AnyWorkflowDefinition {
  const members = options.members ?? 1;
  const graph = createGraph<
    JudgeState,
    { readonly attempts: number; readonly interrupted: number },
    Record<string, unknown>
  >({
    key: 'judging',
    title: 'Judging',
    init: () => ({ attempts: 0, verdict: null, interrupted: 0 }),
    state: {
      attempts: reduce.add(),
      verdict: reduce.replace<string | null>(),
      interrupted: reduce.add(),
    },
    entry: 'judge',
    nodes: {
      judge: operation(async (ctx) => {
        const handles = [];
        for (let index = 0; index < members; index += 1) {
          handles.push(await ctx.runHeadlessAgent({ harness: 'claude', prompt: `judge ${index}` }));
        }
        return suspend({ update: { attempts: 1 }, wait: wait.headlessAgent(handles) });
      }),
      record: operation(async () => complete()),
    },
    edges: {
      'judge-out': edge({
        from: 'judge',
        to: ['record', 'judge', 'abandoned'],
        choose: (state, event) => {
          if (!eventGuards.isHeadless(event)) return { to: 'abandoned' };
          const results = event.results as readonly HeadlessOperationResult[];
          if (results.every((result) => result.status === 'completed')) {
            return { to: 'record' };
          }
          // Bounded: two interruptions and the author gives up rather than looping forever.
          if (state.interrupted >= 1) return { to: 'abandoned' };
          return { to: 'judge', update: { interrupted: 1 } };
        },
      }),
      'record-out': edge({
        from: 'record',
        to: ['delivered'],
        choose: () => ({ to: 'delivered' }),
      }),
    },
    outcomes: {
      delivered: outcome({ kind: 'success', output: (state) => ({ attempts: state.attempts }) }),
      abandoned: outcome({
        kind: 'failure',
        reason: 'judgment_unavailable',
        output: (state) => ({ attempts: state.attempts, interrupted: state.interrupted }),
      }),
    },
  });
  return defineWorkflow({
    command: () => ({ title: 'Judging' }),
    validate: () => {},
    graph,
  }) as AnyWorkflowDefinition;
}

/** The one headless operation currently in flight, with output staged for whoever captures it. */
async function inFlightHeadless(harness: EngineHarness, output: string) {
  const record = (await run(harness.fixture.operations.listUnsettled())).find(
    (candidate) => candidate.capability === 'run_headless_agent',
  );
  assert.ok(record, 'expected a dispatched headless operation');
  harness.adapters.capturedOutput.set(record.ptyProcessId!, { raw: output, output });
  return record;
}

test('a headless launch suspends the visit, and an owned capture is not settled from under it', async () => {
  await withHarness(async (harness) => {
    harness.publish({ workflowKey: 'judging', version: '1', definition: judgingWorkflow() });
    const launched = await harness.launch({ workflowKey: 'judging' });
    await harness.drain();

    const waiting = await harness.runOf(launched.id);
    assert.equal(waiting.status, 'waiting');
    assert.equal(harness.adapters.counters.starts, 1, 'exactly one process was launched');

    const record = await inFlightHeadless(harness, 'looks good');
    // The process terminal is what settles it, through the capture registry the operation service
    // owns — the interpreter never settles an operation itself.
    await run(harness.operations.reconcileExecution(record.executionId).pipe(Effect.asVoid));
    assert.equal(
      (await run(harness.fixture.operations.findById(record.id)))!.state,
      'dispatched',
      'reconciliation settles nothing while this incarnation still owns the capture',
    );
  });
});

test('a capture lost across a restart becomes one interruption the author routes on', async () => {
  await withHarness(async (harness) => {
    harness.publish({ workflowKey: 'judging', version: '1', definition: judgingWorkflow() });
    const launched = await harness.launch({ workflowKey: 'judging' });
    await harness.drain();
    assert.equal(harness.adapters.counters.starts, 1);
    const first = (await run(harness.fixture.operations.listForRun(launched.id)))[0]!;

    // A new incarnation cannot be capturing what the old one started. That is the whole basis for
    // classifying it as interrupted: a positive stored fact, not an empty in-memory map.
    await harness.restart();

    const settled = (await run(harness.fixture.operations.findById(first.id)))!;
    assert.equal(settled.state, 'interrupted');
    const result = (await run(
      harness.fixture.payloads.resolve(settled.result!),
    )) as HeadlessOperationResult;
    assert.equal(result.status, 'interrupted');
    assert.equal(result.interruption?.reason, 'capture_owner_lost');
    assert.ok(result.interruption?.stop, 'stopping is reported separately, never assumed');

    // The interruption was delivered to the armed wait exactly once, and the run is parked awaiting
    // an explicit Resume — recovery never dispatches on its own.
    const waitRow = (await run(harness.fixture.runs.listWaitsForExecution(first.executionId)))[0]!;
    assert.equal(waitRow.status, 'delivered');
    const parked = await harness.runOf(launched.id);
    assert.equal(parked.paused, true);
    assert.equal(parked.position.kind, 'routing');

    assert.equal((await run(harness.controls.resume(launched.id))).accepted, true);
    await harness.drain();

    // The author's bounded route started a *new* execution with a *new* operation — a genuinely new
    // effect — rather than reissuing the one that was lost.
    const operations = await run(harness.fixture.operations.listForRun(launched.id));
    assert.equal(operations.length, 2);
    assert.notEqual(operations[0]!.executionId, operations[1]!.executionId);
    assert.equal(harness.adapters.counters.starts, 2, 'one new launch, never a reissue');
  });
});

test('a callback re-entered after a restart reuses its receipt instead of dispatching again', async () => {
  await withHarness(async (harness) => {
    harness.publish({ workflowKey: 'judging', version: '1', definition: judgingWorkflow() });
    const launched = await harness.launch({ workflowKey: 'judging' });

    // Crash the commit that would have armed the wait. The operation is already dispatched and its
    // receipt recorded; only the graph transition is missing.
    harness.crashNext('commitNodeResult');
    await harness.drain();
    assert.equal(harness.adapters.counters.starts, 1);
    const before = await run(harness.fixture.operations.listForRun(launched.id));
    assert.equal(before.length, 1);

    await harness.restart();
    assert.equal((await run(harness.controls.resume(launched.id))).accepted, true);
    await harness.drain();

    const after = await run(harness.fixture.operations.listForRun(launched.id));
    const forFirstVisit = after.filter((record) => record.executionId === before[0]!.executionId);
    assert.deepEqual(
      forFirstVisit.map((record) => [record.callIndex, record.id]),
      [[0, before[0]!.id]],
      're-entering the callback reached the recorded call position rather than opening a second one',
    );

    // What the re-entered callback found there was a *settled* operation: the restart established
    // that nobody was capturing it any more. So the author's bounded route takes over and starts a
    // genuinely new judgment under a new execution — which is a new effect, not a reissue.
    const later = after.filter((record) => record.executionId !== before[0]!.executionId);
    assert.equal(later.length, 1);
    assert.equal(harness.adapters.counters.starts, 2);
    assert.equal(
      (await run(harness.fixture.operations.findById(before[0]!.id)))!.state,
      'interrupted',
    );
  });
});

test('one callback can launch several operations, and the wait resolves once all of them settle', async () => {
  await withHarness(async (harness) => {
    harness.publish({
      workflowKey: 'judging',
      version: '1',
      definition: judgingWorkflow({ members: 2 }),
    });
    const launched = await harness.launch({ workflowKey: 'judging' });
    await harness.drain();

    assert.equal(harness.adapters.counters.starts, 2);
    const waiting = await harness.runOf(launched.id);
    assert.equal(waiting.status, 'waiting');

    const operations = await run(harness.fixture.operations.listForRun(launched.id));
    assert.deepEqual(
      operations.map((record) => record.callIndex),
      [0, 1],
      'both call positions are recorded under the one execution',
    );
    assert.equal(
      new Set(operations.map((record) => record.executionId)).size,
      1,
      'and they belong to the same node visit',
    );

    // Settling only the first member leaves the wait armed: results reach the router as a complete
    // set, in the author's declared order, rather than waking it repeatedly with a growing list.
    await harness.settleOperation({
      operationId: operations[0]!.id,
      state: 'completed',
      result: { operationId: operations[0]!.operationKey, status: 'completed' },
    });
    assert.equal(await harness.deliver(launched.id), 0);
    assert.equal((await harness.runOf(launched.id)).status, 'waiting');

    await harness.settleOperation({
      operationId: operations[1]!.id,
      state: 'completed',
      result: { operationId: operations[1]!.operationKey, status: 'completed' },
    });
    assert.equal(await harness.deliver(launched.id), 1);
    await harness.drain();
    assert.equal((await harness.runOf(launched.id)).status, 'done');
  });
});

test('an uncertain operation blocks the run, and Retry refuses to manufacture an outcome for it', async () => {
  await withHarness(async (harness) => {
    harness.publish({ workflowKey: 'judging', version: '1', definition: judgingWorkflow() });
    const launched = await harness.launch({ workflowKey: 'judging' });
    await harness.drain();

    const operations = await run(harness.fixture.operations.listForRun(launched.id));
    await run(
      harness.fixture.operations.settle({
        operationId: operations[0]!.id,
        state: 'uncertain',
        uncertaintyDetail: 'ambiguous_turn_attribution:2',
      }),
    );
    // Reconciliation is what turns a settled uncertainty into a blocked run; the two are separate
    // transactions and the repair is explicit rather than assumed.
    await run(
      harness.operations.reconcileExecution(operations[0]!.executionId).pipe(Effect.asVoid),
    );

    const blocked = await harness.runOf(launched.id);
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.blockedOperationId, operations[0]!.id);

    const refused = await Effect.runPromiseExit(harness.controls.retry(launched.id));
    assert.equal(refused._tag, 'Failure');
    const unchanged = await harness.runOf(launched.id);
    assert.equal(unchanged.status, 'blocked');
    assert.equal(unchanged.artifactHash, blocked.artifactHash, 'no pin was adopted');

    // Cancel is the way out. It forfeits continuation and keeps every record.
    assert.equal((await run(harness.controls.cancel(launched.id))).accepted, true);
    const cancelled = await harness.runOf(launched.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(
      (await run(harness.fixture.operations.findById(operations[0]!.id)))!.state,
      'uncertain',
      'the unresolved operation stays visible where it belongs',
    );
    assert.ok((await run(harness.fixture.runs.listFrames(launched.id))).length > 0);
  });
});

test('a fresh visit to the same node performs its effect again', async () => {
  await withHarness(async (harness) => {
    harness.publish({ workflowKey: 'judging', version: '1', definition: judgingWorkflow() });
    const launched = await harness.launch({ workflowKey: 'judging' });
    await harness.drain();

    const first = (await run(harness.fixture.operations.listForRun(launched.id)))[0]!;
    await harness.settleOperation({
      operationId: first.id,
      state: 'interrupted',
      result: { operationId: first.operationKey, status: 'interrupted' },
    });
    // What the resolver's subscriber does when the settlement notification reaches it.
    await harness.deliver(launched.id);
    await harness.drain();

    const operations = await run(harness.fixture.operations.listForRun(launched.id));
    assert.equal(operations.length, 2, 'a revisit is new work, so it allocates a new operation');
    assert.equal(harness.adapters.counters.starts, 2);
    assert.notEqual(operations[0]!.executionId, operations[1]!.executionId);
  });
});

/** A callback whose recorded call sequence the test can edit between versions. */
function editableWorkflow(options: {
  readonly calls: readonly string[];
  readonly thenThrow?: boolean;
}): AnyWorkflowDefinition {
  const graph = createGraph<{ readonly launched: number }, {}, Record<string, unknown>>({
    key: 'editable',
    title: 'Editable',
    init: () => ({ launched: 0 }),
    state: { launched: reduce.add() },
    entry: 'work',
    nodes: {
      work: operation(async (ctx) => {
        const handles = [];
        for (const prompt of options.calls) {
          handles.push(await ctx.runHeadlessAgent({ harness: 'claude', prompt }));
        }
        if (options.thenThrow) throw new Error('the callback failed after launching its work');
        return suspend({ wait: wait.headlessAgent(handles) });
      }),
    },
    edges: {
      'work-out': edge({ from: 'work', to: ['finished'], choose: () => ({ to: 'finished' }) }),
    },
    outcomes: { finished: outcome({ kind: 'success', output: () => ({}) }) },
  });
  return defineWorkflow({
    command: () => ({ title: 'Editable' }),
    validate: () => {},
    graph,
  }) as AnyWorkflowDefinition;
}

test('an edited callback that omits a recorded call is refused before it can commit', async () => {
  await withHarness(async (harness) => {
    harness.publish({
      workflowKey: 'editable',
      version: 'two-calls',
      definition: editableWorkflow({ calls: ['first', 'second'], thenThrow: true }),
    });
    const launched = await harness.launch({ workflowKey: 'editable' });
    await harness.drain();
    assert.equal((await harness.runOf(launched.id)).failureCode, 'node_callback_failed');
    assert.equal(harness.adapters.counters.starts, 2, 'both effects really happened');

    // The repaired version drops the second call. Accepting that would silently orphan an effect
    // that already crossed a boundary into the person's worktree.
    harness.publish({
      workflowKey: 'editable',
      version: 'one-call',
      definition: editableWorkflow({ calls: ['first'] }),
    });
    harness.setCurrent('editable', 'one-call');
    assert.equal((await run(harness.controls.retry(launched.id))).accepted, true);
    await harness.drain();

    const failed = await harness.runOf(launched.id);
    assert.equal(failed.failureCode, 'operation_prefix_unconsumed');
    assert.equal(harness.adapters.counters.starts, 2, 'and no third effect was dispatched');
  });
});

test('an edited callback that changes a recorded request is refused before the new effect is sent', async () => {
  await withHarness(async (harness) => {
    harness.publish({
      workflowKey: 'editable',
      version: 'original',
      definition: editableWorkflow({ calls: ['first'], thenThrow: true }),
    });
    const launched = await harness.launch({ workflowKey: 'editable' });
    await harness.drain();
    assert.equal(harness.adapters.counters.starts, 1);

    harness.publish({
      workflowKey: 'editable',
      version: 'changed-prompt',
      definition: editableWorkflow({ calls: ['a completely different prompt'] }),
    });
    harness.setCurrent('editable', 'changed-prompt');
    assert.equal((await run(harness.controls.retry(launched.id))).accepted, true);
    await harness.drain();

    const failed = await harness.runOf(launched.id);
    assert.equal(failed.failureCode, 'operation_request_changed');
    assert.equal(
      harness.adapters.counters.starts,
      1,
      'the call position identifies one intended effect, and the new one never left',
    );

    // Restoring the original call lets the repair succeed, reusing the receipt rather than
    // dispatching again.
    harness.publish({
      workflowKey: 'editable',
      version: 'restored',
      definition: editableWorkflow({ calls: ['first'] }),
    });
    harness.setCurrent('editable', 'restored');
    assert.equal((await run(harness.controls.retry(launched.id))).accepted, true);
    await harness.drain();

    assert.equal((await harness.runOf(launched.id)).status, 'waiting');
    assert.equal(harness.adapters.counters.starts, 1, 'no additional external dispatch');
  });
});

test('a restart preserves settled members and interrupts only the capture it lost', async () => {
  await withHarness(async (harness) => {
    harness.publish({
      workflowKey: 'judging',
      version: '1',
      definition: judgingWorkflow({ members: 2 }),
    });
    const launched = await harness.launch({ workflowKey: 'judging' });
    await harness.drain();
    assert.equal(harness.adapters.counters.starts, 2);

    const [first, second] = await run(harness.fixture.operations.listForRun(launched.id));
    // The first member finishes normally while this incarnation is still here.
    await harness.settleOperation({
      operationId: first!.id,
      state: 'completed',
      result: { operationId: first!.operationKey, status: 'completed', output: 'approved' },
    });
    const settledAt = (await run(harness.fixture.operations.findById(first!.id)))!.settledAt;

    // The second is still being captured when the process goes away.
    await harness.restart();

    const preserved = (await run(harness.fixture.operations.findById(first!.id)))!;
    assert.equal(preserved.state, 'completed', 'a settled member is never re-settled');
    assert.equal(preserved.settledAt, settledAt);
    assert.deepEqual(
      await run(harness.fixture.payloads.resolve(preserved.result!)),
      { operationId: first!.operationKey, status: 'completed', output: 'approved' },
      'and its result is exactly what was recorded',
    );

    const interrupted = (await run(harness.fixture.operations.findById(second!.id)))!;
    assert.equal(interrupted.state, 'interrupted');
    const interruptedResult = (await run(
      harness.fixture.payloads.resolve(interrupted.result!),
    )) as HeadlessOperationResult;
    assert.equal(interruptedResult.interruption?.reason, 'capture_owner_lost');

    // The aggregate reached the router once, with both members, in the order the author declared.
    const waitRow = (await run(harness.fixture.runs.listWaitsForExecution(first!.executionId)))[0]!;
    assert.equal(waitRow.status, 'delivered');
    const event = (await run(harness.fixture.payloads.resolve(waitRow.event!))) as {
      readonly kind: string;
      readonly results: readonly HeadlessOperationResult[];
    };
    assert.equal(event.kind, 'headless_agent');
    assert.deepEqual(
      event.results.map((result) => [result.operationId, result.status]),
      [
        [first!.operationKey, 'completed'],
        [second!.operationKey, 'interrupted'],
      ],
      'declared input order, so an author can address members positionally',
    );
    assert.equal(
      (
        harness.fixture.client
          .prepare(
            "SELECT count(*) AS count FROM workflow_transitions WHERE run_id = ? AND kind = 'wait_delivered'",
          )
          .get(launched.id) as { count: number }
      ).count,
      1,
      'delivered exactly once',
    );
  });
});

test('a launch left indeterminate stays uncertain, and blocks rather than being guessed at', async () => {
  await withHarness(async (harness) => {
    harness.publish({
      workflowKey: 'judging',
      version: '1',
      definition: judgingWorkflow({ members: 2 }),
    });
    // The second allocation's `start` is interrupted, which leaves the operation at `starting`: a
    // marker saying a spawn may or may not have happened, with no evidence either way. The verb
    // rejects, so the callback never suspends and the segment fails — a live launch failure is a
    // repairable segment failure, never a fabricated agent outcome.
    harness.adapters.launchOutcomes = [{ kind: 'spawned' }, { kind: 'interrupted' }];
    const launched = await harness.launch({ workflowKey: 'judging' });
    await harness.drain();

    const failed = await harness.runOf(launched.id);
    assert.equal(failed.status, 'failed');
    // The verb's own fiber was interrupted, which the capability layer reports as its context
    // closing. It is mapped through as a segment failure code rather than flattened into a generic
    // one, so the inspector can say what actually happened to the call.
    assert.equal(failed.failureCode, 'operation_context_closed');
    const operations = await run(harness.fixture.operations.listForRun(launched.id));
    assert.equal(operations.length, 2);
    assert.equal(operations[1]!.stage, 'starting');
    assert.equal(
      (await run(harness.fixture.runs.listWaitsForExecution(operations[0]!.executionId))).length,
      0,
      'no wait was armed, because the callback never returned a suspend',
    );

    await harness.restart();

    const [first, second] = operations;
    assert.equal(
      (await run(harness.fixture.operations.findById(first!.id)))!.state,
      'interrupted',
      'the member this incarnation was capturing is a confirmed interruption',
    );
    const indeterminate = (await run(harness.fixture.operations.findById(second!.id)))!;
    assert.equal(
      indeterminate.state,
      'uncertain',
      'a `starting` marker with no outcome cannot be classified, and is not guessed at',
    );

    // The run records which operation it cannot account for. A terminal run keeps its status —
    // recording uncertainty must not revive anything — and Retry cannot manufacture an outcome.
    const after = await harness.runOf(launched.id);
    assert.equal(after.status, 'failed');
    assert.equal(after.blockedOperationId, second!.id);
    const refused = await Effect.runPromiseExit(harness.controls.retry(launched.id));
    assert.equal(refused._tag, 'Failure');
    assert.equal(
      (await harness.runOf(launched.id)).artifactHash,
      after.artifactHash,
      'and nothing was repinned around it',
    );
  });
});
