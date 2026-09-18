import assert from 'node:assert/strict';
import test from 'node:test';

import type { OperationContext } from '@yourtechbudstudio/isagi-workflow-sdk';
import { Effect } from 'effect';

import type { WorkflowOperationRecord } from '../persistence/records.js';
import { OperationRejection } from './errors.js';
import {
  crashingOperationsRepository,
  makeOperationHarness,
  run,
  runCallback,
  type OperationHarness,
} from './test-support.js';

/**
 * `close_pane`: the journaled capability whose owner call is already idempotent.
 *
 * That idempotency is why its recovery looks unlike the others — there is no submission marker,
 * because there is no window in which repeating the call could produce a second effect. What still
 * has to hold is everything the call position guarantees: intent before the mutation, one recorded
 * operation, and a re-entry that reuses rather than acts.
 */

const PANE = 41;

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
    );
  } finally {
    await built.close();
  }
}

async function onlyOperation(harness: OperationHarness): Promise<WorkflowOperationRecord> {
  const records = await run(
    harness.fixture.operations.listForExecution(harness.identity.executionId),
  );
  assert.equal(records.length, 1, 'exactly one call position should have been recorded');
  return records[0]!;
}

function transitionKinds(harness: OperationHarness, operationId: number): readonly string[] {
  return (
    harness.fixture.client
      .prepare(
        `SELECT kind FROM workflow_transitions WHERE run_id = ? AND operation_id = ? ORDER BY revision`,
      )
      .all(harness.identity.runId, operationId) as { kind: string }[]
  ).map((row) => row.kind);
}

test('intent is durable before the pane is touched', async () => {
  const harness = await makeOperationHarness();
  try {
    // The owner call fails, so the only thing that can have happened is the part that precedes it.
    harness.state.failures.set('closePane', new Error('surface owner refused'));
    await invoke(harness, (ctx) => ctx.closePane(PANE)).catch(() => undefined);

    const recorded = await onlyOperation(harness);
    assert.equal(recorded.capability, 'close_pane');
    assert.equal(recorded.state, 'intended', 'recorded, and nothing claims it took effect');
    assert.equal(harness.state.counters.paneCloses, 0);
    assert.equal(harness.state.closedPanes.size, 0);
    assert.deepEqual(transitionKinds(harness, recorded.id), ['operation_recorded']);
  } finally {
    harness.close();
  }
});

test('a completed close records the pane it removed', async () => {
  const harness = await makeOperationHarness();
  try {
    await invoke(harness, (ctx) => ctx.closePane(PANE));

    const recorded = await onlyOperation(harness);
    assert.equal(recorded.state, 'completed');
    assert.ok(recorded.settledAt);
    assert.deepEqual(await run(harness.fixture.payloads.resolve(recorded.result!)), {
      paneId: PANE,
    });
    assert.deepEqual(harness.state.closedPanes, new Set([PANE]));
    assert.deepEqual(transitionKinds(harness, recorded.id), [
      'operation_recorded',
      'operation_settled',
    ]);
  } finally {
    harness.close();
  }
});

test('re-entry at a settled position reuses the receipt and closes nothing', async () => {
  const harness = await makeOperationHarness();
  try {
    await invoke(harness, (ctx) => ctx.closePane(PANE));
    const first = await onlyOperation(harness);

    const outcome = await invoke(harness, (ctx) => ctx.closePane(PANE));
    const after = await onlyOperation(harness);
    assert.equal(after.operationKey, first.operationKey);
    assert.equal(after.settledAt, first.settledAt, 'the settlement is untouched');
    // The owner is idempotent, so a second call would have been harmless — which is exactly why the
    // assertion has to be that it did not happen. Harmless is not the same as accounted for.
    assert.equal(harness.state.counters.paneCloses, 1);
    assert.equal(outcome.consumedCallCount, 1);
    assert.equal(outcome.recordedCallCount, 1);
  } finally {
    harness.close();
  }
});

test('a crash after intent but before the owner call dispatches under the same identity', async () => {
  const harness = await makeOperationHarness();
  try {
    harness.state.failures.set('closePane', new Error('surface owner refused'));
    await invoke(harness, (ctx) => ctx.closePane(PANE)).catch(() => undefined);
    const recorded = await onlyOperation(harness);
    assert.equal(recorded.state, 'intended');

    harness.state.failures.delete('closePane');
    await invoke(harness, (ctx) => ctx.closePane(PANE));

    const after = await onlyOperation(harness);
    assert.equal(after.operationKey, recorded.operationKey, 'the same operation, not a second one');
    assert.equal(after.state, 'completed');
    assert.equal(harness.state.counters.paneCloses, 1);
  } finally {
    harness.close();
  }
});

test('a crash after the owner close but before settlement converges on one removed pane', async () => {
  const harness = await makeOperationHarness();
  try {
    // The window `close_pane` has instead of a submission marker: the owner mutation happened and
    // nothing recorded it. There is no marker because repeating an idempotent close cannot produce
    // a second effect — which this proves rather than assumes.
    await invoke(harness, (ctx) => ctx.closePane(PANE), {
      operations: crashingOperationsRepository(harness.fixture.operations, { onSettle: true }),
    }).catch(() => undefined);

    const crashed = await onlyOperation(harness);
    assert.equal(crashed.state, 'intended', 'the settlement rolled back');
    assert.equal(harness.state.counters.paneCloses, 1);

    await invoke(harness, (ctx) => ctx.closePane(PANE));

    const after = await onlyOperation(harness);
    assert.equal(after.operationKey, crashed.operationKey);
    assert.equal(after.state, 'completed');
    // The call really did happen twice, and the resource changed once. That distinction is the whole
    // reason this capability needs no pre-write marker.
    assert.equal(harness.state.counters.paneCloses, 2);
    assert.deepEqual(harness.state.closedPanes, new Set([PANE]));
  } finally {
    harness.close();
  }
});

test('a changed pane at a recorded position is refused before any owner call', async () => {
  const harness = await makeOperationHarness();
  try {
    await invoke(harness, (ctx) => ctx.closePane(PANE));
    assert.equal(harness.state.counters.paneCloses, 1);

    let rejection: unknown;
    await invoke(harness, (ctx) => ctx.closePane(PANE + 1)).catch((cause) => {
      rejection = cause;
    });
    assert.ok(rejection instanceof OperationRejection);
    assert.equal((rejection as OperationRejection).code, 'operation_request_changed');
    // Closing a different pane is a different intended effect, and adopting the recorded one would
    // have reported success for a pane nobody asked about.
    assert.equal(harness.state.counters.paneCloses, 1);
    assert.deepEqual(harness.state.closedPanes, new Set([PANE]));
  } finally {
    harness.close();
  }
});

test('Cancel with a close still unsettled reports an honest, idempotent stop', async () => {
  const harness = await makeOperationHarness();
  try {
    harness.state.failures.set('closePane', new Error('surface owner refused'));
    await invoke(harness, (ctx) => ctx.closePane(PANE)).catch(() => undefined);
    const pending = await onlyOperation(harness);
    assert.equal(pending.state, 'intended');

    const built = await harness.service();
    let summary;
    try {
      summary = await Effect.runPromise(
        built.service.stopOwnedOperations({ runId: harness.identity.runId, reason: 'cancelled' }),
      );
    } finally {
      await built.close();
    }

    assert.equal(summary.requested, 1);
    assert.equal(summary.confirmed, 1);
    const stopped = await onlyOperation(harness);
    // Nothing needs killing and nothing is being claimed about a process: closing a pane converges
    // through the surface owner, so `confirmed` here is a statement about idempotency rather than
    // about having stopped something.
    assert.equal(stopped.stopState, 'confirmed');
    assert.equal(stopped.stopDetail, 'close_pane_is_idempotent');
    assert.ok(transitionKinds(harness, stopped.id).includes('stop_recorded'));
  } finally {
    harness.close();
  }
});
