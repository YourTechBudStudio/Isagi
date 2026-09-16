import assert from 'node:assert/strict';
import test from 'node:test';

import { makeWorkflowHistoryRepository } from './history.repository.js';
import type { WorkflowWriteResult } from './outcomes.js';
import {
  makeWorkflowPersistenceFixture,
  prepareClaim,
  run,
  type WorkflowPersistenceFixture,
} from './test-support.js';

const PIN = 'a'.repeat(64);

function value<A>(result: WorkflowWriteResult<A>): A {
  assert.ok(result.ok, `expected a commit, got ${JSON.stringify(result)}`);
  return result.value;
}

async function runWithHistory(fixture: WorkflowPersistenceFixture) {
  fixture.seedArtifact(PIN);
  const created = value(
    await run(
      fixture.runs.createRun({
        workflowKey: 'fixture',
        title: 'Fixture',
        rootGraphKey: 'root',
        artifactHash: PIN,
        rootFrame: { graphKey: 'root' },
        origin: {
          worktreeId: null,
          worktreePath: null,
          surfaceId: null,
          paneId: null,
          agentSessionId: null,
        },
        destination: { worktreeId: null, worktreePath: null, surfaceId: null },
        attachment: null,
      }),
    ),
  );
  return created.run.id;
}

/** Appends `count` diagnostics, each its own transition, so history has something to page over. */
async function appendDiagnostics(
  fixture: WorkflowPersistenceFixture,
  runId: number,
  count: number,
  from = 0,
) {
  for (let index = from; index < from + count; index += 1) {
    value(
      await run(
        fixture.runs.appendDiagnostic({
          runId,
          kind: 'log',
          detail: { value: { source: 'author_log', level: 'info', message: `entry-${index}` } },
        }),
      ),
    );
  }
}

test('history reads in revision order, bounded by the page size', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const history = makeWorkflowHistoryRepository(fixture.database);
    const runId = await runWithHistory(fixture);
    await appendDiagnostics(fixture, runId, 9);

    // `run_started` plus nine diagnostics.
    assert.equal(await run(history.countForRun(runId)), 10);
    assert.equal(await run(history.currentRevision(runId)), 10);

    const page = await run(history.since({ runId, sinceRevision: 0, limit: 4 }));
    assert.deepEqual(
      page.transitions.map((transition) => transition.revision),
      [1, 2, 3, 4],
    );
    assert.equal(page.highWaterRevision, 10);
  } finally {
    fixture.close();
  }
});

test('a page is bounded by the high-water it reported, so newer work is left for the next page', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const history = makeWorkflowHistoryRepository(fixture.database);
    const runId = await runWithHistory(fixture);
    await appendDiagnostics(fixture, runId, 9);

    const first = await run(history.since({ runId, sinceRevision: 0, limit: 4 }));
    const boundary = first.highWaterRevision;
    assert.equal(boundary, 10);

    // More history commits *while* the caller is still paging. A page must never reach above the
    // boundary it already reported, or a caller that acknowledges coverage up to that boundary
    // would be acknowledging revisions it was never handed.
    await appendDiagnostics(fixture, runId, 5, 9);
    assert.equal(await run(history.currentRevision(runId)), 15);

    const second = await run(history.since({ runId, sinceRevision: 4, limit: 4 }));
    assert.deepEqual(
      second.transitions.map((transition) => transition.revision),
      [5, 6, 7, 8],
    );
    const third = await run(history.since({ runId, sinceRevision: 8, limit: 4 }));
    assert.deepEqual(
      third.transitions.map((transition) => transition.revision),
      [9, 10, 11, 12],
      'a later page reports the boundary as it stands then, and may legitimately go further',
    );

    // Walking from zero at the original boundary yields every revision once, in order, with no gap
    // and no repeat — which is the property a client applying deltas one past the last depends on.
    const walked: number[] = [];
    let cursor = 0;
    for (let guard = 0; guard < 20 && cursor < boundary; guard += 1) {
      const page = await run(history.since({ runId, sinceRevision: cursor, limit: 3 }));
      if (page.transitions.length === 0) break;
      walked.push(...page.transitions.map((transition) => transition.revision));
      cursor = page.transitions.at(-1)!.revision;
    }
    assert.deepEqual(
      walked.filter((revision) => revision <= boundary),
      Array.from({ length: boundary }, (_, index) => index + 1),
    );
  } finally {
    fixture.close();
  }
});

test('history is scoped to its run, and an unknown run reads as empty rather than failing', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const history = makeWorkflowHistoryRepository(fixture.database);
    const first = await runWithHistory(fixture);
    const second = await runWithHistory(fixture);
    await appendDiagnostics(fixture, first, 3);

    assert.equal(await run(history.countForRun(first)), 4);
    assert.equal(await run(history.countForRun(second)), 1, 'only its own run_started');
    const page = await run(history.since({ runId: second, sinceRevision: 0, limit: 50 }));
    assert.deepEqual(
      page.transitions.map((transition) => transition.kind),
      ['run_started'],
    );
    assert.ok(page.transitions.every((transition) => transition.runId === second));

    // Absent, not an error: a caller asking about a run that no longer exists gets an honest empty
    // answer with a zero boundary rather than a fault.
    assert.equal(await run(history.currentRevision(9999)), null);
    const missing = await run(history.since({ runId: 9999, sinceRevision: 0, limit: 10 }));
    assert.deepEqual(missing.transitions, []);
    assert.equal(missing.highWaterRevision, 0);
  } finally {
    fixture.close();
  }
});

test('reading from the current revision yields nothing, without claiming more coverage', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const history = makeWorkflowHistoryRepository(fixture.database);
    const runId = await runWithHistory(fixture);
    await appendDiagnostics(fixture, runId, 2);

    const caughtUp = await run(history.since({ runId, sinceRevision: 3, limit: 10 }));
    assert.deepEqual(caughtUp.transitions, []);
    assert.equal(caughtUp.highWaterRevision, 3, 'an empty page still reports the real boundary');

    // A cursor past the end is not an error and does not invent coverage.
    const ahead = await run(history.since({ runId, sinceRevision: 99, limit: 10 }));
    assert.deepEqual(ahead.transitions, []);
    assert.equal(ahead.highWaterRevision, 3);
  } finally {
    fixture.close();
  }
});

test('every committed transition is readable back, including several from one transaction', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const history = makeWorkflowHistoryRepository(fixture.database);
    fixture.seedArtifact(PIN);
    const placement = fixture.seedPlacement();
    const created = value(
      await run(
        fixture.runs.createRun({
          workflowKey: 'fixture',
          title: 'Fixture',
          rootGraphKey: 'root',
          artifactHash: PIN,
          rootFrame: { graphKey: 'root' },
          origin: {
            worktreeId: placement.worktreeId,
            worktreePath: '/repo/fixture',
            surfaceId: placement.surfaceId,
            paneId: null,
            agentSessionId: null,
          },
          destination: {
            worktreeId: placement.worktreeId,
            worktreePath: '/repo/fixture',
            surfaceId: placement.surfaceId,
          },
          attachment: { worktreeId: placement.worktreeId, surfaceId: placement.surfaceId },
        }),
      ),
    );
    const entry = value(
      await run(
        fixture.runs.claimSegment({
          ...(await prepareClaim(fixture, created.run.id)),
          owner: 'worker-1',
          ownerIncarnation: 'incarnation-1',
        }),
      ),
    );
    value(
      await run(
        fixture.runs.commitGraphEntry({
          runId: created.run.id,
          attemptId: entry.attempt.id,
          owner: 'worker-1',
          ownerIncarnation: 'incarnation-1',
          frameId: created.frame.id,
          state: { value: { count: 0 } },
          entryNode: { nodeId: 'work', nodeKind: 'operation' },
        }),
      ),
    );
    const callback = value(
      await run(
        fixture.runs.claimSegment({
          ...(await prepareClaim(fixture, created.run.id)),
          owner: 'worker-1',
          ownerIncarnation: 'incarnation-1',
        }),
      ),
    );
    // Suspending writes two transitions in one transaction.
    value(
      await run(
        fixture.runs.commitNodeResult({
          runId: created.run.id,
          attemptId: callback.attempt.id,
          owner: 'worker-1',
          ownerIncarnation: 'incarnation-1',
          frameId: created.frame.id,
          executionId: callback.attempt.executionId!,
          state: { value: { count: 1 } },
          producerOutput: { value: { update: { count: 1 } } },
          producerArtifactHash: PIN,
          next: {
            kind: 'suspend',
            waitKind: 'user_continue',
            condition: { value: { kind: 'user_continue' } },
          },
        }),
      ),
    );

    const page = await run(history.since({ runId: created.run.id, sinceRevision: 0, limit: 100 }));
    assert.deepEqual(
      page.transitions.map((transition) => transition.kind),
      [
        'run_started',
        'node_dispatched',
        'graph_entered',
        'node_dispatched',
        'state_reduced',
        'wait_armed',
      ],
    );
    assert.deepEqual(
      page.transitions.map((transition) => transition.revision),
      [1, 2, 3, 4, 5, 6],
    );
    // The armed wait's identity is carried on its transition, so a reader recovering by revision
    // can resolve it without a second query shape.
    assert.ok(page.transitions.at(-1)!.waitId);
  } finally {
    fixture.close();
  }
});
