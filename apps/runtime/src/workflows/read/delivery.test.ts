import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Fiber, Queue } from 'effect';

import type { RuntimeEvent } from '@isagi/contracts';

import type { RuntimeEventBusService } from '../../runtime-events/event-bus.js';
import { makeWorkflowOperationsRepository } from '../persistence/operations.repository.js';
import { makeWorkflowRunsRepository } from '../persistence/runs.repository.js';
import type { WorkflowWriteWakeService } from '../persistence/write-wake.js';
import { makeWorkflowDeltaPublisher } from './publisher.js';
import {
  captureEvidence,
  claim,
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
 * How a committed transition reaches a client, and what that path costs.
 *
 * Two properties are asserted here that nothing else can: that *every* workflow write wakes the
 * publisher — because a write that forgot to would be a delta nobody delivered — and that a read
 * stays proportional to the page it returns and writes nothing at all.
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

/** A wake that records every signal instead of parking a drainer. */
function recordingWake() {
  const signals: number[] = [];
  const service: WorkflowWriteWakeService = {
    signal: Effect.sync(() => {
      signals.push(signals.length + 1);
    }),
    awaitSignal: Effect.void,
  };
  return { service, signals };
}

test('every workflow write wakes the publisher, and no read does', async () => {
  await withHarness(async (harness) => {
    const wake = recordingWake();
    const runs = makeWorkflowRunsRepository(
      harness.fixture.database,
      harness.fixture.payloads,
      wake.service,
    );
    const operations = makeWorkflowOperationsRepository(
      harness.fixture.database,
      harness.fixture.payloads,
      wake.service,
    );
    const { runId, rootFrameId } = await startRun(harness.fixture);
    const execution = await enterRoot(harness.fixture, {
      runId,
      frameId: rootFrameId,
      nodeId: 'writer',
    });
    const before = wake.signals.length;

    // A committing write, a *rejected* write, and an operation write all signal: the wake says only
    // that a transaction ran, which is why it can never disagree with what committed.
    const attempt = await claim(harness.fixture, runId);
    value(
      await run(
        runs.appendDiagnostic({
          runId,
          kind: 'log',
          frameId: rootFrameId,
          detail: { value: { source: 'author_log', level: 'info', message: 'hello' } },
        }),
      ),
    );
    const afterCommit = wake.signals.length;
    assert.equal(afterCommit, before + 1);

    const rejected = await run(
      runs.applyResume({
        runId,
        controlRevision: 9999,
        expectedPosition: { kind: 'terminal' },
      }),
    );
    assert.equal(rejected.ok, false);
    assert.equal(
      wake.signals.length,
      afterCommit + 1,
      'a refused write wakes too, and finds nothing',
    );

    value(
      await run(
        operations.recordIntent({
          runId,
          frameId: rootFrameId,
          executionId: execution.id,
          originAttemptId: attempt.attempt.id,
          capability: 'send_agent_prompt',
          callIndex: 0,
          request: { value: { prompt: 'x' } },
          fingerprintOf: { value: { prompt: 'x' } },
          artifactHash: PIN_A,
        }),
      ),
    );
    assert.equal(wake.signals.length, afterCommit + 2);

    const quiet = wake.signals.length;
    await run(runs.findRun(runId));
    await run(runs.listFrames(runId));
    await run(operations.listForRun(runId));
    await read(harness.projection.listRunExecutions(runId, {}));
    assert.equal(wake.signals.length, quiet, 'reads are not writes and do not pretend to be');
  });
});

test('a committed write reaches the public bus without anybody asking it to', async () => {
  await withHarness(async (harness) => {
    const events: RuntimeEvent[] = [];
    const bus: Pick<RuntimeEventBusService, 'publish'> = {
      publish: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
    };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // The real wake, a real drainer fibre, and a repository that only knows it finished a
          // transaction — the same composition the runtime layer builds.
          const queue = yield* Queue.sliding<void>(1);
          const wake: WorkflowWriteWakeService = {
            signal: queue.offer(void 0).pipe(Effect.asVoid),
            awaitSignal: queue.take.pipe(Effect.asVoid),
          };
          const publisher = makeWorkflowDeltaPublisher(harness.fixture.database, bus, 0);
          const fibre = yield* Effect.forkScoped(
            Effect.forever(wake.awaitSignal.pipe(Effect.zipRight(publisher.drainOnce))),
          );
          const runs = makeWorkflowRunsRepository(
            harness.fixture.database,
            harness.fixture.payloads,
            wake,
          );

          const { runId, rootFrameId } = yield* await0(startRun(harness.fixture));
          yield* runs.appendDiagnostic({
            runId,
            kind: 'ui_feedback',
            frameId: rootFrameId,
            detail: {
              value: { source: 'ui_feedback', kind: 'info', phase: 'writing', message: 'drafting' },
            },
          });
          // Give the drainer its turn; the assertion is that nothing had to poke it by hand.
          yield* Effect.sleep('50 millis');
          yield* Fiber.interrupt(fibre);
        }),
      ),
    );

    const deltas = events.filter((event) => event.type === 'workflow_run_transition');
    assert.ok(deltas.length > 0, 'the drainer published on its own');
    const feedback = events.find(
      (event) => event.type === 'workflow_run_changed' && event.payload.uiFeedback !== null,
    );
    assert.ok(feedback, 'and surface bookkeeping rode along with the same summary');
  });
});

test('a read costs what its page costs, and writes nothing', async () => {
  await withHarness(async (harness) => {
    const { runId, rootFrameId } = await startRun(harness.fixture);
    await enterRoot(harness.fixture, { runId, frameId: rootFrameId, nodeId: 'writer' });
    // A long run: 120 visits, so a page of 10 must not cost anything like the whole history.
    for (let index = 0; index < 120; index += 1) {
      const inserted = harness.fixture.client
        .prepare(
          `INSERT INTO workflow_node_executions
             (run_id, frame_id, node_id, node_kind, visit_index, status, started_at, end_certainty)
           VALUES (?, ?, ?, 'operation', ?, 'completed', ?, 'observed')
           RETURNING id`,
        )
        .get(
          runId,
          rootFrameId,
          'writer',
          index + 1,
          `2026-01-02T00:00:${String(index).padStart(2, '0')}.000Z`,
        ) as { id: number };
      // A diagnostic naming the row is what gives it a snapshot, the same way any real write would.
      value(
        await run(
          harness.fixture.runs.appendDiagnostic({
            runId,
            kind: 'log',
            frameId: rootFrameId,
            executionId: inserted.id,
            detail: { value: { source: 'author_log', level: 'info', message: `visit ${index}` } },
          }),
        ),
      );
    }

    const counter = countStatements(harness);
    await read(harness.projection.listRunExecutions(runId, { limit: 10 }));
    const small = counter.stop();

    const counterLarge = countStatements(harness);
    await read(harness.projection.listRunExecutions(runId, { limit: 50 }));
    const large = counterLarge.stop();

    assert.equal(small.writes, 0, 'a read performs no reconciliation, repair or other mutation');
    assert.equal(large.writes, 0);
    // One ordering query, one snapshot lookup per row, and a bounded tail for frames and the run.
    // A hundred and twenty visits are in the database; neither page pays for them.
    assert.ok(
      small.reads <= 20,
      `a ten-row page should cost about ten lookups, took ${small.reads}`,
    );
    assert.ok(
      large.reads <= small.reads + 60,
      `cost tracks the page, not the run: ${small.reads} then ${large.reads}`,
    );

    const eventCounter = countStatements(harness);
    await read(harness.projection.listEvents(runId, { sinceRevision: 0, limit: 20 }));
    const events = eventCounter.stop();
    assert.equal(events.writes, 0);
    assert.ok(
      events.reads <= 10,
      `a delta page is one batch of transitions and one of changes, took ${events.reads}`,
    );
  });
});

/** Counts prepared statements by kind, which is how a query cost is measured honestly. */
function countStatements(harness: ReadHarness) {
  const client = harness.fixture.client as unknown as { prepare: (sql: string) => unknown };
  const original = client.prepare.bind(client);
  let reads = 0;
  let writes = 0;
  client.prepare = (sql: string) => {
    if (/^\s*(insert|update|delete|create|drop)/i.test(sql)) writes += 1;
    else reads += 1;
    return original(sql);
  };
  return {
    stop: () => {
      client.prepare = original;
      return { reads, writes };
    },
  };
}

/** `await` inside an Effect generator, for the few test helpers that are promise-shaped. */
function await0<A>(promise: Promise<A>): Effect.Effect<A> {
  return Effect.promise(() => promise) as unknown as Effect.Effect<A>;
}

test('surface bookkeeping announces a released attachment once, when it is released', async () => {
  await withHarness(async (harness) => {
    const { runId, rootFrameId, placement } = await startRun(harness.fixture);
    await enterRoot(harness.fixture, { runId, frameId: rootFrameId, nodeId: 'writer' });
    const before = await run(harness.fixture.runs.findRun(runId));
    value(
      await run(
        harness.fixture.runs.applyCancel({ runId, controlRevision: before!.controlRevision }),
      ),
    );
    await read(harness.publisher.drainOnce);
    const beforeDismiss = harness.events.filter(
      (event) => event.type === 'workflow_run_detached',
    ).length;
    assert.equal(beforeDismiss, 0, 'stopping a run does not release its surface');

    const cancelled = await run(harness.fixture.runs.findRun(runId));
    value(
      await run(
        harness.fixture.runs.detachRun({ runId, controlRevision: cancelled!.controlRevision }),
      ),
    );
    await read(harness.publisher.drainOnce);

    const detached = harness.events.filter((event) => event.type === 'workflow_run_detached');
    assert.equal(detached.length, 1);
    assert.deepEqual(detached[0]!.payload, { runId, surfaceId: placement.surfaceId });

    // A later transition on the same detached run does not announce it again.
    value(
      await run(
        harness.fixture.runs.appendDiagnostic({
          runId,
          kind: 'log',
          frameId: rootFrameId,
          detail: { value: { source: 'author_log', level: 'info', message: 'after dismissal' } },
        }),
      ),
    );
    await read(harness.publisher.drainOnce);
    assert.equal(
      harness.events.filter((event) => event.type === 'workflow_run_detached').length,
      1,
      'detachment is an edge, not a state the stream repeats',
    );
  });
});

test('a completed capture re-delivers its execution, and every ancestor of a nested one', async () => {
  await withHarness(async (harness) => {
    const { runId, rootFrameId } = await startRun(harness.fixture);
    const writer = await enterRoot(harness.fixture, {
      runId,
      frameId: rootFrameId,
      nodeId: 'writer',
    });
    await read(harness.publisher.drainOnce);

    /** The captured counts this drain delivered, per execution. */
    const delivered = async () => {
      harness.events.length = 0;
      await read(harness.publisher.drainOnce);
      const counts = new Map<number, number>();
      for (const event of harness.events) {
        if (event.type !== 'workflow_run_transition') continue;
        for (const execution of event.payload.changes.executions) {
          counts.set(execution.executionId, execution.operationSummary.evidenceCaptured);
        }
      }
      return counts;
    };

    const callback = await claim(harness.fixture, runId);
    const intent = await captureEvidence(harness.fixture, {
      runId,
      frameId: rootFrameId,
      executionId: writer.id,
      attemptId: callback.attempt.id,
      callIndex: 0,
      title: 'Draft',
      role: 'draft',
      settle: false,
    });
    assert.equal(
      (await delivered()).get(writer.id),
      0,
      'recording the intent delivers the execution with nothing captured yet',
    );

    const published = await run(
      harness.fixture.content.put({ source: Buffer.from('Draft'), mediaTypeHint: 'text/plain' }),
    );
    value(
      await run(
        harness.fixture.evidence.commitCapture({
          operation: intent.operation,
          attemptId: callback.attempt.id,
          title: 'Draft',
          role: 'draft',
          labels: null,
          contentKind: 'text',
          mediaType: 'text/plain',
          byteSize: published.byteSize,
          contentRef: published.contentRef,
          sourcePath: null,
          source: { kind: 'none', agentSessionId: null, operationId: null, attribution: 'none' },
          now: new Date().toISOString(),
        }),
      ),
    );
    assert.equal(
      (await delivered()).get(writer.id),
      1,
      'the commit that writes the evidence row is the one that moves the count on the wire',
    );

    // A capture inside a child frame must re-deliver the ancestor whose subtree count it changed —
    // otherwise a dock showing the parent would keep an out-of-date number with nothing to correct it.
    value(
      await run(
        harness.fixture.runs.commitNodeResult({
          ...fence(runId, callback.attempt.id),
          frameId: rootFrameId,
          executionId: writer.id,
          state: { value: { rounds: 1 } },
          producerOutput: { value: { type: 'route' } },
          producerArtifactHash: PIN_A,
          next: { kind: 'routing', edgeId: 'writer-out' },
        }),
      ),
    );
    const routing = await claim(harness.fixture, runId);
    value(
      await run(
        harness.fixture.runs.commitRouting({
          ...fence(runId, routing.attempt.id),
          frameId: rootFrameId,
          executionId: writer.id,
          state: { value: { rounds: 1 } },
          producerOutput: { value: { to: 'review' } },
          producerArtifactHash: PIN_A,
          next: { kind: 'node', nodeId: 'review', nodeKind: 'subgraph' },
        }),
      ),
    );
    const subgraph = (await run(harness.fixture.runs.listExecutions(rootFrameId))).at(-1)!;
    const before = await run(harness.fixture.runs.findRun(runId));
    const childFrameId = value(
      await run(
        harness.fixture.runs.enterSubgraph({
          runId,
          controlRevision: before!.controlRevision,
          expectedPosition: before!.position,
          artifactHash: PIN_A,
          parentExecutionId: subgraph.id,
          childGraphKey: 'review',
          childDisplayName: 'review round 0',
        }),
      ),
    ).childFrameId;
    const childEntry = await claim(harness.fixture, runId);
    value(
      await run(
        harness.fixture.runs.commitGraphEntry({
          ...fence(runId, childEntry.attempt.id),
          frameId: childFrameId,
          parameters: { value: { draft: 'v1' } },
          state: { value: { verdict: null } },
          entryNode: { nodeId: 'judge', nodeKind: 'operation' },
        }),
      ),
    );
    const nested = (await run(harness.fixture.runs.listExecutions(childFrameId))).at(-1)!;
    const nestedCallback = await claim(harness.fixture, runId);
    await read(harness.publisher.drainOnce);

    await captureEvidence(harness.fixture, {
      runId,
      frameId: childFrameId,
      executionId: nested.id,
      attemptId: nestedCallback.attempt.id,
      callIndex: 0,
      title: 'Verdict',
      role: 'verdict',
    });
    const counts = await delivered();
    assert.equal(counts.get(nested.id), 1, 'the nested execution reports its own capture');
    assert.equal(
      counts.get(subgraph.id),
      1,
      'and its ancestor is re-delivered with the subtree-inclusive total',
    );
  });
});
