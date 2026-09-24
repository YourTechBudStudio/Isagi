import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import type {
  ListRunExecutionsOutput,
  ListWorkflowEventsOutput,
  ListWorkflowOperationsOutput,
  RuntimeEvent,
  WorkflowExecutionDto,
  WorkflowFrameDto,
  WorkflowOperationDto,
  WorkflowRunSummary,
  WorkflowRunTransitionDelta,
} from '@isagi/contracts';

import {
  claim,
  currentRun,
  enterRoot,
  fence,
  makeReadHarness,
  PIN_A,
  run,
  startRun,
  value,
  type ReadHarness,
} from './test-support.js';

/**
 * Delivery, and what survives losing it.
 *
 * The contract these tests hold the runtime to is narrow and load-bearing: a client that applied
 * every live delta and a client that lost them all and refetched must end up believing exactly the
 * same thing. That is only true if live publication and REST recovery decode the *same* durable
 * records, so most of what follows is a comparison between the two paths rather than a check that
 * either one is individually plausible.
 */

async function withHarness(body: (harness: ReadHarness) => Promise<void>) {
  const harness = makeReadHarness();
  try {
    await body(harness);
  } finally {
    harness.close();
  }
}

function read<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
  return Effect.runPromise(effect as Effect.Effect<A, never>);
}

function deltasOf(events: readonly RuntimeEvent[]): readonly WorkflowRunTransitionDelta[] {
  return events
    .filter(
      (event): event is Extract<RuntimeEvent, { type: 'workflow_run_transition' }> =>
        event.type === 'workflow_run_transition',
    )
    .map((event) => event.payload);
}

/** Every delta the REST history route serves, paged exactly as a client would page it. */
async function restDeltas(harness: ReadHarness, runId: number, since?: number, limit = 100) {
  const items: WorkflowRunTransitionDelta[] = [];
  let cursor: string | undefined;
  let boundary: ListWorkflowEventsOutput['boundary'] | undefined;
  const readEvents = (page: { readonly cursor?: string | undefined }) =>
    harness.projection.listEvents(runId, {
      ...(since === undefined ? {} : { sinceRevision: since }),
      ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
      limit,
    });
  for (;;) {
    const page = await read(readEvents({ cursor }));
    items.push(...page.items);
    boundary = page.boundary;
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return { items, boundary: boundary! };
}

/**
 * A client's cache, applying deltas by the one rule the contract states: a delta is applied only
 * when its revision is exactly one past the last applied.
 */
class Client {
  executions = new Map<number, WorkflowExecutionDto>();
  frames = new Map<number, WorkflowFrameDto>();
  operations = new Map<string, WorkflowOperationDto>();
  summary: WorkflowRunSummary | null = null;
  applied = 0;
  gaps = 0;

  apply(delta: WorkflowRunTransitionDelta): 'applied' | 'gap' | 'duplicate' {
    if (delta.revision <= this.applied) return 'duplicate';
    if (delta.revision !== this.applied + 1) {
      this.gaps += 1;
      return 'gap';
    }
    this.absorb(delta.changes);
    this.applied = delta.revision;
    return 'applied';
  }

  absorb(changes: WorkflowRunTransitionDelta['changes']): void {
    for (const execution of changes.executions)
      this.executions.set(execution.executionId, execution);
    for (const frame of changes.frames) this.frames.set(frame.frameId, frame);
    for (const operation of changes.operations)
      this.operations.set(operation.operationKey, operation);
    if (changes.summary && (!this.summary || changes.summary.revision >= this.summary.revision)) {
      this.summary = changes.summary;
    }
  }

  /** Gap recovery through the executions route, which carries its own changed records. */
  absorbRecovery(page: ListRunExecutionsOutput): void {
    for (const execution of page.items) this.executions.set(execution.executionId, execution);
    this.absorb({ executions: [], ...page.changes });
    this.applied = page.boundary.coverageRevision;
  }
}

/** A direct, consistent read of everything the client should have converged on. */
async function directView(harness: ReadHarness, runId: number) {
  const executions = await read(harness.projection.listRunExecutions(runId, { limit: 500 }));
  const frames = await read(harness.projection.listFrames(runId, { limit: 500 }));
  const operations = await read(harness.projection.listOperations(runId, { limit: 500 }));
  const summary = (await read(harness.projection.getRun(runId))).run;
  return {
    executions: executions.items,
    frames: frames.items,
    operations: operations.items,
    summary,
  };
}

/** Drives a small run that touches every delivery shape: a visit, a wait, an operation, a repair. */
async function driveScenario(harness: ReadHarness) {
  const { runId, rootFrameId } = await startRun(harness.fixture);
  const execution = await enterRoot(harness.fixture, {
    runId,
    frameId: rootFrameId,
    nodeId: 'writer',
  });
  const attempt = await claim(harness.fixture, runId);
  const operation = value(
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
  value(
    await run(
      harness.fixture.runs.commitNodeResult({
        ...fence(runId, attempt.attempt.id),
        frameId: rootFrameId,
        executionId: execution.id,
        state: { value: { rounds: 1 } },
        producerOutput: { value: { type: 'suspend' } },
        producerArtifactHash: PIN_A,
        next: {
          kind: 'suspend',
          waitKind: 'agent_turn',
          condition: { value: { kind: 'agent_turn', target: { agentSessionId: 1 } } },
        },
      }),
    ),
  );
  return { runId, rootFrameId, executionId: execution.id, operationId: operation.id, operation };
}

test('every live delta is byte-identical to the same revision replayed from REST', async () => {
  await withHarness(async (harness) => {
    const scenario = await driveScenario(harness);
    await read(harness.publisher.drainOnce);

    const live = deltasOf(harness.events);
    const replayed = await restDeltas(harness, scenario.runId, 0);

    assert.ok(live.length > 5, 'the scenario produced a real history');
    assert.deepEqual(
      replayed.items.map((delta) => delta.revision),
      live.map((delta) => delta.revision),
      'the same revisions, in the same order',
    );
    assert.deepEqual(replayed.items, live, 'and the same records, not merely the same shape');
    assert.equal(replayed.boundary.complete, true);
    assert.equal(
      replayed.boundary.coverageRevision,
      replayed.boundary.highWaterRevision,
      'a completed recovery covers its own high-water revision',
    );
  });
});

test('a client that applied every delta and one that lost them all converge on the same state', async () => {
  await withHarness(async (harness) => {
    const scenario = await driveScenario(harness);
    await read(harness.publisher.drainOnce);

    const streamed = new Client();
    for (const delta of deltasOf(harness.events)) {
      assert.equal(delta.runId, scenario.runId);
      assert.equal(streamed.apply(delta), 'applied');
    }

    const recovered = new Client();
    const replayed = await restDeltas(harness, scenario.runId, 0);
    for (const delta of replayed.items) assert.equal(recovered.apply(delta), 'applied');

    const direct = await directView(harness, scenario.runId);
    for (const client of [streamed, recovered]) {
      assert.deepEqual([...client.executions.values()], direct.executions);
      assert.deepEqual(
        [...client.frames.values()].map((frame) => frame.frameId),
        direct.frames.map((frame) => frame.frameId),
      );
      assert.deepEqual([...client.operations.values()], direct.operations);
      assert.deepEqual(client.summary, direct.summary);
    }
  });
});

test('a duplicate delta is inert and a reordered one is refused as a gap', async () => {
  await withHarness(async (harness) => {
    const scenario = await driveScenario(harness);
    await read(harness.publisher.drainOnce);
    const deltas = deltasOf(harness.events);

    const client = new Client();
    client.apply(deltas[0]!);
    assert.equal(client.apply(deltas[0]!), 'duplicate');
    assert.equal(client.apply(deltas[2]!), 'gap', 'a revision out of order is never applied blind');
    assert.equal(client.applied, 1);

    // The same drain twice publishes nothing more: the cursor is durable state, not a hope.
    const before = harness.events.length;
    assert.equal(await read(harness.publisher.drainOnce), 0);
    assert.equal(harness.events.length, before);
    assert.equal(scenario.runId > 0, true);
  });
});

test('a dropped notification is repaired through the executions route, records and all', async () => {
  await withHarness(async (harness) => {
    const scenario = await driveScenario(harness);
    await read(harness.publisher.drainOnce);
    const deltas = deltasOf(harness.events);

    // The client applies the first two revisions and then stops hearing anything.
    const client = new Client();
    client.apply(deltas[0]!);
    client.apply(deltas[1]!);
    const lost = deltas.slice(2);
    assert.ok(lost.length > 0);
    assert.equal(client.apply(lost.at(-1)!), 'gap');

    const page = await read(
      harness.projection.listRunExecutions(scenario.runId, { sinceRevision: client.applied }),
    );
    client.absorbRecovery(page);

    const direct = await directView(harness, scenario.runId);
    assert.deepEqual([...client.executions.values()], direct.executions);
    assert.deepEqual([...client.operations.values()], direct.operations);
    assert.deepEqual(client.summary, direct.summary);
    assert.equal(
      client.applied,
      direct.summary.revision,
      'the client may now claim exactly the coverage it was given',
    );
  });
});

test('an operation-only change is recoverable even though no node ran', async () => {
  await withHarness(async (harness) => {
    const scenario = await driveScenario(harness);
    await read(harness.publisher.drainOnce);
    const client = new Client();
    for (const delta of deltasOf(harness.events)) client.apply(delta);
    const settledFrom = client.applied;

    // The attempt that dispatched this operation has already ended; the operation settles anyway.
    value(
      await run(
        harness.fixture.operations.settle({
          operationId: scenario.operationId,
          state: 'completed',
          result: { value: { status: 'completed' } },
        }),
      ),
    );

    const page = await read(
      harness.projection.listRunExecutions(scenario.runId, { sinceRevision: settledFrom }),
    );
    assert.deepEqual(
      page.changes.operations.map((operation) => [operation.operationKey, operation.state]),
      [[scenario.operation.operationKey, 'completed']],
      'the settlement reaches a client through the executions recovery route',
    );
    assert.ok(
      page.items.some((execution) => execution.executionId === scenario.executionId),
      'and so does the visit whose operation summary changed',
    );

    client.absorbRecovery(page);
    assert.equal(client.operations.get(scenario.operation.operationKey)?.state, 'completed');
    const direct = await directView(harness, scenario.runId);
    assert.deepEqual([...client.operations.values()], direct.operations);

    // The same fact is in the history route, at its own revision, with no new execution alongside it.
    const events = await restDeltas(harness, scenario.runId, settledFrom);
    const settlement = events.items.find((delta) => delta.transition.kind === 'operation_settled');
    assert.ok(settlement, 'settlement is its own transition');
    assert.equal(settlement!.changes.operations[0]?.state, 'completed');
  });
});

test('a missed Retry notification still leaves a reconnecting client on the current pin', async () => {
  await withHarness(async (harness) => {
    const scenario = await driveScenario(harness);
    await read(harness.publisher.drainOnce);
    const client = new Client();
    for (const delta of deltasOf(harness.events)) client.apply(delta);
    const beforeRetry = client.applied;

    const before = await currentRun(harness.fixture, scenario.runId);
    value(
      await run(
        harness.fixture.runs.applyCancel({
          runId: scenario.runId,
          controlRevision: before.controlRevision,
        }),
      ),
    );

    // Nothing was delivered: the client reconnects and asks for everything after what it had.
    const events = await restDeltas(harness, scenario.runId, beforeRetry);
    for (const delta of events.items) client.apply(delta);
    assert.ok(
      events.items.some((delta) => delta.transition.kind === 'control_applied'),
      'the control that changed the run is in the recovered history',
    );
    assert.equal(client.summary?.status, 'cancelled');
    const direct = await directView(harness, scenario.runId);
    assert.equal(client.summary?.artifactHash, direct.summary.artifactHash);
    assert.equal(client.summary?.pinOrdinal, direct.summary.pinOrdinal);
  });
});

test('one transaction that writes several transitions publishes each, in order, after it commits', async () => {
  await withHarness(async (harness) => {
    const { runId, rootFrameId } = await startRun(harness.fixture);
    const execution = await enterRoot(harness.fixture, {
      runId,
      frameId: rootFrameId,
      nodeId: 'writer',
    });
    await read(harness.publisher.drainOnce);
    const beforeSuspend = deltasOf(harness.events).at(-1)!.revision;

    const attempt = await claim(harness.fixture, runId);
    value(
      await run(
        harness.fixture.runs.commitNodeResult({
          ...fence(runId, attempt.attempt.id),
          frameId: rootFrameId,
          executionId: execution.id,
          state: { value: { rounds: 1 } },
          producerOutput: { value: { type: 'suspend' } },
          producerArtifactHash: PIN_A,
          next: {
            kind: 'suspend',
            waitKind: 'agent_turn',
            condition: { value: { kind: 'agent_turn', target: { agentSessionId: 1 } } },
          },
        }),
      ),
    );
    await read(harness.publisher.drainOnce);

    const written = deltasOf(harness.events).filter((delta) => delta.revision > beforeSuspend + 1);
    assert.deepEqual(
      written.map((delta) => delta.transition.kind),
      ['state_reduced', 'wait_armed'],
      'a suspend commits a reduction and an armed wait as two transitions',
    );
    assert.deepEqual(
      written.map((delta) => delta.revision),
      [written[0]!.revision, written[0]!.revision + 1],
      'which take consecutive revisions',
    );
    assert.deepEqual(
      written[0]!.changes,
      { executions: [], frames: [], operations: [] },
      'the projection is attached once, to the revision the transaction ended on',
    );
    assert.equal(written[1]!.changes.executions.length, 1);
    assert.equal(written[1]!.changes.executions[0]!.wait?.status, 'armed');
  });
});

test('a rolled-back transaction publishes nothing and leaves no read-model trace', async () => {
  await withHarness(async (harness) => {
    const { runId, rootFrameId } = await startRun(harness.fixture);
    await enterRoot(harness.fixture, { runId, frameId: rootFrameId, nodeId: 'writer' });
    const attempt = await claim(harness.fixture, runId);
    await read(harness.publisher.drainOnce);
    const publishedBefore = harness.events.length;
    const revisionBefore = (await currentRun(harness.fixture, runId)).revision;
    const snapshotsBefore = harness.fixture.client
      .prepare('SELECT count(*) as count FROM workflow_transition_changes')
      .get() as { count: number };

    // A commit that raises inside its transaction: everything it wrote, including its history and
    // its change snapshots, goes with it.
    await assert.rejects(
      Effect.runPromise(
        harness.fixture.runs.commitNodeResult({
          ...fence(runId, attempt.attempt.id),
          frameId: rootFrameId,
          executionId: 999_999,
          state: { value: { rounds: 1 } },
          producerOutput: { value: { type: 'complete' } },
          producerArtifactHash: PIN_A,
          next: { kind: 'routing', edgeId: 'writer-out' },
        }) as Effect.Effect<unknown, never>,
      ),
    );

    assert.equal(await read(harness.publisher.drainOnce), 0);
    assert.equal(harness.events.length, publishedBefore);
    const after = harness.fixture.client
      .prepare('SELECT count(*) as count FROM workflow_transition_changes')
      .get() as { count: number };
    assert.equal(after.count, snapshotsBefore.count);
    assert.equal(
      (await currentRun(harness.fixture, runId)).revision,
      revisionBefore,
      'a rolled-back transaction consumed no revision either',
    );
  });
});

test('a recovery page never acknowledges history it did not deliver', async () => {
  await withHarness(async (harness) => {
    const scenario = await driveScenario(harness);
    const total = (await currentRun(harness.fixture, scenario.runId)).revision;
    assert.ok(total > 3);

    const first = await read(
      harness.projection.listEvents(scenario.runId, { sinceRevision: 0, limit: 2 }),
    );
    assert.equal(first.items.length, 2);
    assert.equal(first.boundary.complete, false);
    assert.equal(first.boundary.coverageRevision, first.items.at(-1)!.revision);
    assert.equal(first.boundary.highWaterRevision, total);
    assert.ok(first.nextCursor !== null);

    // A write lands between the pages. It belongs to the next batch, not to this frozen one.
    const before = await currentRun(harness.fixture, scenario.runId);
    value(
      await run(
        harness.fixture.runs.applyPause({
          runId: scenario.runId,
          controlRevision: before.controlRevision,
        }),
      ),
    );

    let cursor: string | null = first.nextCursor;
    let last = first.boundary;
    const seen = [...first.items];
    while (cursor !== null) {
      const page: ListWorkflowEventsOutput = await read(
        harness.projection.listEvents(scenario.runId, {
          sinceRevision: 0,
          limit: 2,
          cursor,
          snapshotToken: first.boundary.snapshotToken,
        }),
      );
      seen.push(...page.items);
      last = page.boundary;
      cursor = page.nextCursor;
    }
    assert.equal(
      last.highWaterRevision,
      total,
      'the boundary stayed frozen across the whole batch',
    );
    assert.equal(last.coverageRevision, total);
    assert.deepEqual(
      seen.map((delta) => delta.revision),
      Array.from({ length: total }, (_value, index) => index + 1),
      'every revision within the boundary arrived exactly once',
    );
    assert.ok(
      (await currentRun(harness.fixture, scenario.runId)).revision > total,
      'and the writes that happened during pagination are simply beyond it',
    );
  });
});

test('a cursor is bound to its run, route, filters and boundary', async () => {
  await withHarness(async (harness) => {
    const first = await startRun(harness.fixture, { workflowKey: 'first' });
    const second = await startRun(harness.fixture, { workflowKey: 'second' });
    await enterRoot(harness.fixture, {
      runId: first.runId,
      frameId: first.rootFrameId,
      nodeId: 'writer',
    });
    await enterRoot(harness.fixture, {
      runId: second.runId,
      frameId: second.rootFrameId,
      nodeId: 'writer',
    });

    const page = await read(
      harness.projection.listEvents(first.runId, { sinceRevision: 0, limit: 1 }),
    );
    const cursor = page.nextCursor!;

    const refusals = [
      // Another run's cursor.
      harness.projection.listEvents(second.runId, { sinceRevision: 0, limit: 1, cursor }),
      // The same run, a different lower bound.
      harness.projection.listEvents(first.runId, { sinceRevision: 1, limit: 1, cursor }),
      // Another route.
      harness.projection.listAttempts(first.runId, { cursor }),
      // Not a cursor at all.
      harness.projection.listEvents(first.runId, { sinceRevision: 0, cursor: 'nonsense' }),
    ];
    for (const refusal of refusals) {
      const result = await Effect.runPromise(
        Effect.either(refusal as Effect.Effect<unknown, never>),
      );
      assert.equal(result._tag, 'Left');
      assert.equal((result as { left: { code: string } }).left.code, 'workflow_cursor_invalid');
    }

    // A different filter set on the same route is a different listing, not a continuation of this one.
    const attempts = await read(harness.projection.listAttempts(first.runId, { limit: 1 }));
    if (attempts.nextCursor !== null) {
      const mismatched = await Effect.runPromise(
        Effect.either(
          harness.projection.listAttempts(first.runId, {
            limit: 1,
            segmentKind: 'graph_entry',
            cursor: attempts.nextCursor,
          }) as Effect.Effect<unknown, never>,
        ),
      );
      assert.equal(mismatched._tag, 'Left');
    }
  });
});

test('history far past a thousand transitions pages without a cap', async () => {
  await withHarness(async (harness) => {
    const { runId, rootFrameId } = await startRun(harness.fixture);
    await enterRoot(harness.fixture, { runId, frameId: rootFrameId, nodeId: 'writer' });
    for (let index = 0; index < 1100; index += 1) {
      value(
        await run(
          harness.fixture.runs.appendDiagnostic({
            runId,
            kind: 'log',
            frameId: rootFrameId,
            detail: { value: { source: 'author_log', level: 'info', message: `step ${index}` } },
          }),
        ),
      );
    }
    const total = (await currentRun(harness.fixture, runId)).revision;
    assert.ok(total > 1100);

    const replayed = await restDeltas(harness, runId, 0, 500);
    assert.equal(replayed.items.length, total, 'no historical cap, and no page lost or repeated');
    assert.equal(replayed.boundary.complete, true);
    assert.deepEqual(
      replayed.items.map((delta) => delta.revision),
      Array.from({ length: total }, (_value, index) => index + 1),
    );

    await read(harness.publisher.drainOnce);
    assert.equal(
      deltasOf(harness.events).length,
      total,
      'and the publisher drains a long backlog in batches without dropping any',
    );
  });
});

test('executions page in a stable order even when two visits share a timestamp', async () => {
  await withHarness(async (harness) => {
    const { runId, rootFrameId } = await startRun(harness.fixture);
    await enterRoot(harness.fixture, { runId, frameId: rootFrameId, nodeId: 'writer' });
    // Two more visits stamped identically, which is what a fast loop really produces.
    const stamp = '2026-01-01T00:00:00.000Z';
    for (const nodeId of ['reviewer', 'publisher']) {
      harness.fixture.client
        .prepare(
          `INSERT INTO workflow_node_executions
             (run_id, frame_id, node_id, node_kind, visit_index, status, started_at, end_certainty)
           VALUES (?, ?, ?, 'operation', 0, 'running', ?, 'observed')`,
        )
        .run(runId, rootFrameId, nodeId, stamp);
    }
    harness.fixture.client
      .prepare('UPDATE workflow_node_executions SET started_at = ? WHERE node_id = ?')
      .run(stamp, 'writer');
    // Rows inserted outside the repository have no snapshot, so give them one the honest way: a
    // diagnostic naming each execution captures its state at its own revision.
    for (const row of harness.fixture.client
      .prepare('SELECT id FROM workflow_node_executions WHERE run_id = ?')
      .all(runId) as { id: number }[]) {
      value(
        await run(
          harness.fixture.runs.appendDiagnostic({
            runId,
            kind: 'log',
            frameId: rootFrameId,
            executionId: row.id,
            detail: { value: { source: 'author_log', level: 'info', message: 'seen' } },
          }),
        ),
      );
    }

    const ids: number[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page: ListRunExecutionsOutput = await read(
        harness.projection.listRunExecutions(runId, {
          limit: 1,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
      ids.push(...page.items.map((execution) => execution.executionId));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    assert.deepEqual(
      ids,
      [...ids].sort((left, right) => left - right),
    );
    assert.equal(new Set(ids).size, ids.length, 'a tie moves no row across a page boundary');
    assert.equal(ids.length, 3);
  });
});

test('operations page by their durable call position', async () => {
  await withHarness(async (harness) => {
    const { runId, rootFrameId } = await startRun(harness.fixture);
    const execution = await enterRoot(harness.fixture, {
      runId,
      frameId: rootFrameId,
      nodeId: 'writer',
    });
    const attempt = await claim(harness.fixture, runId);
    for (let callIndex = 0; callIndex < 5; callIndex += 1) {
      value(
        await run(
          harness.fixture.operations.recordIntent({
            runId,
            frameId: rootFrameId,
            executionId: execution.id,
            originAttemptId: attempt.attempt.id,
            capability: 'send_agent_prompt',
            callIndex,
            request: { value: { prompt: `step ${callIndex}` } },
            fingerprintOf: { value: { prompt: `step ${callIndex}` } },
            artifactHash: PIN_A,
          }),
        ),
      );
    }

    const seen: number[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page: ListWorkflowOperationsOutput = await read(
        harness.projection.listOperations(runId, {
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
      seen.push(...page.items.map((operation) => operation.callIndex));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    assert.deepEqual(seen, [0, 1, 2, 3, 4]);
  });
});

test('a baseline read stays on its own boundary while the run keeps moving', async () => {
  await withHarness(async (harness) => {
    const scenario = await driveScenario(harness);
    // A second visit, so a page of one is genuinely a partial baseline.
    const armed = (await run(harness.fixture.runs.listArmedWaits(scenario.runId)))[0]!;
    value(
      await run(
        harness.fixture.runs.deliverWait({
          waitId: armed.id,
          event: { value: { kind: 'agent_turn', outcome: 'ended' } },
          edgeId: 'writer-out',
        }),
      ),
    );
    const routing = await claim(harness.fixture, scenario.runId);
    value(
      await run(
        harness.fixture.runs.commitRouting({
          ...fence(scenario.runId, routing.attempt.id),
          frameId: scenario.rootFrameId,
          executionId: scenario.executionId,
          state: { value: { rounds: 2 } },
          producerOutput: { value: { to: 'reviewer' } },
          producerArtifactHash: PIN_A,
          waitId: armed.id,
          next: { kind: 'node', nodeId: 'reviewer', nodeKind: 'operation' },
        }),
      ),
    );

    const first = await read(harness.projection.listRunExecutions(scenario.runId, { limit: 1 }));
    assert.equal(first.items.length, 1);
    assert.ok(first.nextCursor !== null);
    assert.equal(first.boundary.complete, false);
    assert.equal(
      first.boundary.coverageRevision,
      0,
      'a half-read baseline acknowledges nothing at all',
    );

    // The run advances between pages, which is the ordinary case for a live waterfall.
    value(
      await run(
        harness.fixture.runs.appendDiagnostic({
          runId: scenario.runId,
          kind: 'log',
          frameId: scenario.rootFrameId,
          detail: { value: { source: 'author_log', level: 'info', message: 'still going' } },
        }),
      ),
    );

    // The continuation carries its own boundary: it neither fails nor silently moves to a newer one.
    const second: ListRunExecutionsOutput = await read(
      harness.projection.listRunExecutions(scenario.runId, {
        limit: 50,
        cursor: first.nextCursor!,
      }),
    );
    assert.equal(second.boundary.highWaterRevision, first.boundary.highWaterRevision);
    assert.equal(second.boundary.complete, true);
    assert.equal(second.boundary.coverageRevision, first.boundary.highWaterRevision);
    assert.equal(second.boundary.snapshotToken, first.boundary.snapshotToken);

    // A token naming a different boundary is a contradiction, not a preference.
    const contradicted = await Effect.runPromise(
      Effect.either(
        harness.projection.listRunExecutions(scenario.runId, {
          limit: 50,
          cursor: first.nextCursor!,
          snapshotToken: second.boundary.snapshotToken.slice(0, -1) + 'x',
        }) as Effect.Effect<unknown, never>,
      ),
    );
    assert.equal(contradicted._tag, 'Left');
  });
});

test('a pause band survives losing every notification that carried it', async () => {
  await withHarness(async (harness) => {
    const scenario = await driveScenario(harness);
    await read(harness.publisher.drainOnce);
    const beforePause = deltasOf(harness.events).at(-1)!.revision;

    const paused = await currentRun(harness.fixture, scenario.runId);
    value(
      await run(
        harness.fixture.runs.applyPause({
          runId: scenario.runId,
          controlRevision: paused.controlRevision,
        }),
      ),
    );
    const gated = (await read(harness.projection.getRun(scenario.runId))).run;
    assert.equal(gated.paused, true);
    assert.equal(gated.controls.resume, true);

    const resuming = await currentRun(harness.fixture, scenario.runId);
    value(
      await run(
        harness.fixture.runs.applyResume({
          runId: scenario.runId,
          controlRevision: resuming.controlRevision,
          expectedPosition: resuming.position,
        }),
      ),
    );
    await read(harness.publisher.drainOnce);

    // The band as the live stream carried it: an opening, a closing, and the control that ended it.
    const live = deltasOf(harness.events).filter((delta) => delta.revision > beforePause);
    assert.deepEqual(
      live.map((delta) => delta.transition.kind),
      ['pause_opened', 'pause_closed', 'control_applied'],
      'the vocabulary is explicit: a band has two ends, and a control is a separate fact',
    );
    assert.deepEqual(
      live.map((delta) => delta.revision),
      [beforePause + 1, beforePause + 2, beforePause + 3],
      'consecutive revisions, in order',
    );
    assert.ok(
      live[0]!.transition.recordedAt <= live[1]!.transition.recordedAt,
      'and the band never closes before it opened',
    );

    // The same band, for a client that heard none of it.
    const replayed = await restDeltas(harness, scenario.runId, beforePause);
    assert.deepEqual(
      replayed.items,
      live,
      'REST reproduces the band from the same durable records',
    );

    // Duplicate and reordered delivery neither duplicates nor inverts it.
    const client = new Client();
    client.applied = beforePause;
    const shuffled = [live[1]!, live[0]!, live[0]!, live[1]!, live[2]!];
    const bands: string[] = [];
    for (const delta of shuffled) {
      if (client.apply(delta) !== 'applied') continue;
      if (delta.transition.kind === 'pause_opened' || delta.transition.kind === 'pause_closed') {
        bands.push(delta.transition.kind);
      }
    }
    assert.deepEqual(bands, ['pause_opened', 'pause_closed']);
    assert.equal(client.applied, beforePause + 3);

    // And the gate facts converge with the summary at the boundary.
    const direct = await directView(harness, scenario.runId);
    assert.equal(client.summary?.paused, false);
    assert.equal(client.summary?.revision, direct.summary.revision);
    assert.deepEqual(client.summary?.controls, direct.summary.controls);
  });
});

test('a boundary the run never reached is refused, however it was asked for', async () => {
  await withHarness(async (harness) => {
    const scenario = await driveScenario(harness);
    const reached = (await currentRun(harness.fixture, scenario.runId)).revision;
    const honest = await read(
      harness.projection.listEvents(scenario.runId, { sinceRevision: 0, limit: 1 }),
    );

    /** Re-encodes a token or cursor with edited internals, as a client editing base64 JSON would. */
    const tamper = (encoded: string, change: (payload: Record<string, unknown>) => unknown) => {
      const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<
        string,
        unknown
      >;
      return Buffer.from(JSON.stringify(change(payload) ?? payload), 'utf8').toString('base64url');
    };

    const refusals: Effect.Effect<unknown, unknown>[] = [
      // A snapshot token naming a revision the run has not reached. Accepting it would let a page
      // that ran out of rows report completion at a revision that does not exist, and a client
      // following the protocol would then skip the real deltas as already covered.
      harness.projection.listEvents(scenario.runId, {
        sinceRevision: 0,
        snapshotToken: tamper(honest.boundary.snapshotToken, (payload) => ({
          ...payload,
          highWaterRevision: reached + 500,
        })),
      }),
      // The same lie told through a cursor instead.
      harness.projection.listEvents(scenario.runId, {
        sinceRevision: 0,
        cursor: tamper(honest.nextCursor!, (payload) => ({
          ...payload,
          highWater: reached + 500,
        })),
      }),
      // A negative boundary, and a non-numeric one.
      harness.projection.listEvents(scenario.runId, {
        sinceRevision: 0,
        snapshotToken: tamper(honest.boundary.snapshotToken, (payload) => ({
          ...payload,
          highWaterRevision: -1,
        })),
      }),
      harness.projection.listEvents(scenario.runId, {
        sinceRevision: 0,
        cursor: tamper(honest.nextCursor!, (payload) => ({ ...payload, highWater: 'soon' })),
      }),
      // Ordering keys that are not orderings: empty, unbounded, and made of the wrong things.
      harness.projection.listEvents(scenario.runId, {
        sinceRevision: 0,
        cursor: tamper(honest.nextCursor!, (payload) => ({ ...payload, key: [] })),
      }),
      harness.projection.listEvents(scenario.runId, {
        sinceRevision: 0,
        cursor: tamper(honest.nextCursor!, (payload) => ({
          ...payload,
          key: Array.from({ length: 50 }, (_value, index) => index),
        })),
      }),
      harness.projection.listEvents(scenario.runId, {
        sinceRevision: 0,
        cursor: tamper(honest.nextCursor!, (payload) => ({ ...payload, key: [{ sneaky: true }] })),
      }),
      harness.projection.listEvents(scenario.runId, {
        sinceRevision: 0,
        cursor: tamper(honest.nextCursor!, (payload) => ({ ...payload, key: [Number.NaN] })),
      }),
    ];

    for (const [index, refusal] of refusals.entries()) {
      const result = await Effect.runPromise(
        Effect.either(refusal as Effect.Effect<unknown, never>),
      );
      assert.equal(result._tag, 'Left', `refusal ${index} was accepted`);
      assert.equal(
        (result as { left: { code: string } }).left.code,
        'workflow_cursor_invalid',
        `refusal ${index}`,
      );
    }

    // And the honest continuation still works, so the validation refuses lies rather than cursors.
    const next = await read(
      harness.projection.listEvents(scenario.runId, {
        sinceRevision: 0,
        limit: 1,
        cursor: honest.nextCursor!,
      }),
    );
    assert.equal(next.boundary.highWaterRevision, reached);
    assert.ok(next.items.length > 0);
  });
});

test('an ordering key of the wrong shape is refused on every route that pages', async () => {
  await withHarness(async (harness) => {
    const scenario = await driveScenario(harness);
    // A second visit, so the waterfall listing has a continuation to hand out too. Without it a page
    // of one is the whole run, there is no cursor to reshape, and the timestamp-key cases below
    // would pass by never running.
    const armed = (await run(harness.fixture.runs.listArmedWaits(scenario.runId)))[0]!;
    value(
      await run(
        harness.fixture.runs.deliverWait({
          waitId: armed.id,
          event: { value: { kind: 'agent_turn', outcome: 'ended' } },
          edgeId: 'writer-out',
        }),
      ),
    );
    const routing = await claim(harness.fixture, scenario.runId);
    value(
      await run(
        harness.fixture.runs.commitRouting({
          ...fence(scenario.runId, routing.attempt.id),
          frameId: scenario.rootFrameId,
          executionId: scenario.executionId,
          state: { value: { rounds: 2 } },
          producerOutput: { value: { to: 'reviewer' } },
          producerArtifactHash: PIN_A,
          waitId: armed.id,
          next: { kind: 'node', nodeId: 'reviewer', nodeKind: 'operation' },
        }),
      ),
    );

    // More calls on the same visit, so every route below has a second page to continue onto. They
    // belong to the attempt that already recorded the first one: an operation outlives its attempt.
    for (let callIndex = 1; callIndex < 3; callIndex += 1) {
      value(
        await run(
          harness.fixture.operations.recordIntent({
            runId: scenario.runId,
            frameId: scenario.rootFrameId,
            executionId: scenario.executionId,
            originAttemptId: scenario.operation.originAttemptId,
            capability: 'send_agent_prompt',
            callIndex,
            request: { value: { prompt: `step ${callIndex}` } },
            fingerprintOf: { value: { prompt: `step ${callIndex}` } },
            artifactHash: PIN_A,
          }),
        ),
      );
    }

    const reshape = (encoded: string, key: unknown) => {
      const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<
        string,
        unknown
      >;
      return Buffer.from(JSON.stringify({ ...payload, key }), 'utf8').toString('base64url');
    };
    const refused = async (effect: Effect.Effect<unknown, unknown>, what: string) => {
      const result = await Effect.runPromise(
        Effect.either(effect as Effect.Effect<unknown, never>),
      );
      assert.equal(result._tag, 'Left', what);
      assert.equal(
        (result as { left: { code: string } }).left.code,
        'workflow_cursor_invalid',
        what,
      );
    };

    // A revision key: one number, and nothing else will do.
    const events = await read(
      harness.projection.listEvents(scenario.runId, { sinceRevision: 0, limit: 1 }),
    );
    for (const [what, key] of [
      ['a revision that is a string', ['not-a-revision']],
      ['a revision with a second part', [1, 2]],
      ['a revision that is a boolean', [true]],
    ] as const) {
      await refused(
        harness.projection.listEvents(scenario.runId, {
          sinceRevision: 0,
          cursor: reshape(events.nextCursor!, key),
        }),
        what,
      );
    }

    // A compound call position: two numbers, in that order.
    const operations = await read(harness.projection.listOperations(scenario.runId, { limit: 1 }));
    for (const [what, key] of [
      ['a call position missing its index', [1]],
      ['a call position whose index is a string', [1, 'zero']],
      ['a call position with a third part', [1, 0, 0]],
    ] as const) {
      await refused(
        harness.projection.listOperations(scenario.runId, {
          limit: 1,
          cursor: reshape(operations.nextCursor!, key),
        }),
        what,
      );
    }

    // The waterfall's key: a timestamp then an id, never the other way round.
    const executions = await read(
      harness.projection.listRunExecutions(scenario.runId, { limit: 1 }),
    );
    assert.ok(
      executions.nextCursor !== null,
      'the run must have a second page, or the cases below assert nothing',
    );
    for (const [what, key] of [
      ['a start time that is a number', [1, 2]],
      ['an execution id that is a string', ['2026-01-01T00:00:00.000Z', 'one']],
      ['an empty start time', ['', 1]],
    ] as const) {
      await refused(
        harness.projection.listRunExecutions(scenario.runId, {
          limit: 1,
          cursor: reshape(executions.nextCursor, key),
        }),
        what,
      );
    }

    // And each route still continues from its own honest cursor.
    const nextEvents = await read(
      harness.projection.listEvents(scenario.runId, {
        sinceRevision: 0,
        limit: 1,
        cursor: events.nextCursor!,
      }),
    );
    assert.equal(nextEvents.items.length, 1);
    const nextOperations = await read(
      harness.projection.listOperations(scenario.runId, {
        limit: 1,
        cursor: operations.nextCursor!,
      }),
    );
    assert.equal(nextOperations.items[0]?.callIndex, 1);
  });
});
