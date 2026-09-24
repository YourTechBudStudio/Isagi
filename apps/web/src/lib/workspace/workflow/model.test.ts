import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyDelta,
  applyExecutionsPage,
  applySummary,
  emptyRunState,
  orderedExecutions,
  selectOperations,
  withCoverage,
  type WorkflowRunState,
} from './model.js';
import {
  executionsPageFixture,
  workflowDeltaFixture,
  workflowExecutionFixture,
  workflowOperationFixture,
  workflowSummaryFixture,
} from './test-support.js';
import { applyTransitionFacts, currentArtifactHash } from './transition-facts.js';

test('execution order follows the start clock, not the order rows arrived in', () => {
  const rows = [
    workflowExecutionFixture({ executionId: 5, startedAt: t(5) }),
    workflowExecutionFixture({ executionId: 2, startedAt: t(2) }),
    workflowExecutionFixture({ executionId: 9, startedAt: t(9) }),
    workflowExecutionFixture({ executionId: 3, startedAt: t(3) }),
  ];

  // A gap fill hands rows back by revision, which has nothing to do with when they started. The
  // waterfall reads one clock, so arrival order must not reach it.
  const scrambled = rows.reduce<WorkflowRunState>(
    (state, row) =>
      applyExecutionsPage(state, executionsPageFixture({ items: [row], highWaterRevision: 1 })),
    emptyRunState(1),
  );
  const inOrder = applyExecutionsPage(
    emptyRunState(1),
    executionsPageFixture({
      items: [...rows].sort((left, right) => left.executionId - right.executionId),
      highWaterRevision: 1,
    }),
  );

  assert.deepEqual(
    orderedExecutions(scrambled).map((execution) => execution.executionId),
    [2, 3, 5, 9],
  );
  assert.deepEqual(
    orderedExecutions(scrambled).map((execution) => execution.executionId),
    orderedExecutions(inOrder).map((execution) => execution.executionId),
  );
});

test('two executions that started in the same instant are separated by id, stably', () => {
  const state = applyExecutionsPage(
    emptyRunState(1),
    executionsPageFixture({
      items: [
        workflowExecutionFixture({ executionId: 8, startedAt: t(1) }),
        workflowExecutionFixture({ executionId: 4, startedAt: t(1) }),
      ],
      highWaterRevision: 1,
    }),
  );
  assert.deepEqual(
    orderedExecutions(state).map((execution) => execution.executionId),
    [4, 8],
  );
});

test('a re-sent execution updates in place without moving or duplicating', () => {
  const first = applyExecutionsPage(
    emptyRunState(1),
    executionsPageFixture({
      items: [
        workflowExecutionFixture({ executionId: 1, startedAt: t(1) }),
        workflowExecutionFixture({ executionId: 2, startedAt: t(2) }),
      ],
      highWaterRevision: 1,
    }),
  );
  const updated = applyExecutionsPage(
    first,
    executionsPageFixture({
      items: [workflowExecutionFixture({ executionId: 1, startedAt: t(1), status: 'completed' })],
      highWaterRevision: 2,
    }),
  );

  assert.deepEqual(
    orderedExecutions(updated).map((execution) => execution.executionId),
    [1, 2],
  );
  assert.equal(updated.executions.get(1)?.status, 'completed');
});

test('a delta is refused until a baseline exists, because there is nothing for it to be contiguous with', () => {
  const result = applyDelta(emptyRunState(1), workflowDeltaFixture({ revision: 1 }));
  assert.equal(result.outcome, 'gap');
});

test('a page never advances coverage on its own', () => {
  const state = applyExecutionsPage(
    emptyRunState(1),
    executionsPageFixture({ highWaterRevision: 9, coverageRevision: 4, complete: false }),
  );
  assert.equal(state.coverageRevision, 0);
  assert.equal(state.hydrated, false);
  assert.equal(withCoverage(state, 4).coverageRevision, 4);
});

test('a summary for another run is ignored rather than adopted', () => {
  const state = withCoverage(emptyRunState(1), 1);
  const foreign = workflowSummaryFixture({ runId: 2, revision: 50 });
  assert.equal(applySummary(state, foreign).summary, null);
});

test('operation membership follows the operation, and ordering is by call position', () => {
  const state = applyExecutionsPage(
    emptyRunState(1),
    executionsPageFixture({
      highWaterRevision: 1,
      operations: [
        workflowOperationFixture({ operationKey: 'b', executionId: 1, callIndex: 1 }),
        workflowOperationFixture({ operationKey: 'a', executionId: 1, callIndex: 0 }),
        workflowOperationFixture({ operationKey: 'c', executionId: 2, callIndex: 0 }),
      ],
    }),
  );

  assert.deepEqual(
    selectOperations(state, { executionId: 1 }).map((operation) => operation.operationKey),
    ['a', 'b'],
  );
  assert.deepEqual(
    selectOperations(state).map((operation) => operation.operationKey),
    ['a', 'b', 'c'],
  );
});

test('pause bands open and close once, however often their transitions are replayed', () => {
  const base = withCoverage(emptyRunState(1), 0);
  const opened = workflowDeltaFixture({
    revision: 4,
    transition: { kind: 'pause_opened', recordedAt: t(4) },
  });
  const closed = workflowDeltaFixture({
    revision: 7,
    transition: { kind: 'pause_closed', recordedAt: t(7) },
  });

  // Recovery legitimately re-reads revisions a live delta already delivered.
  const state = [opened, opened, closed, closed].reduce(applyTransitionFacts, base);

  assert.deepEqual(state.pauseIntervals, [
    { openedAtRevision: 4, openedAt: t(4), closedAt: t(7), closedAtRevision: 7 },
  ]);
});

test('a replayed close lands on the band it ended, not on a later one still open', () => {
  const base = withCoverage(emptyRunState(1), 0);
  const state = [
    workflowDeltaFixture({ revision: 4, transition: { kind: 'pause_opened', recordedAt: t(4) } }),
    workflowDeltaFixture({ revision: 7, transition: { kind: 'pause_closed', recordedAt: t(7) } }),
    workflowDeltaFixture({ revision: 9, transition: { kind: 'pause_opened', recordedAt: t(9) } }),
  ].reduce(applyTransitionFacts, base);

  // A recovery re-reads history from the beginning while the run is paused again. Closing
  // "whichever band is open" would close the live pause with a timestamp from two pauses ago, and
  // the waterfall would show a band that ended before it started.
  const replayed = [
    workflowDeltaFixture({ revision: 4, transition: { kind: 'pause_opened', recordedAt: t(4) } }),
    workflowDeltaFixture({ revision: 7, transition: { kind: 'pause_closed', recordedAt: t(7) } }),
  ].reduce(applyTransitionFacts, state);

  assert.deepEqual(replayed.pauseIntervals, [
    { openedAtRevision: 4, openedAt: t(4), closedAt: t(7), closedAtRevision: 7 },
    { openedAtRevision: 9, openedAt: t(9), closedAt: null, closedAtRevision: null },
  ]);
});

test('the current pin is the summary when there is one, and the last adoption otherwise', () => {
  const adopted = applyTransitionFacts(
    withCoverage(emptyRunState(1), 0),
    workflowDeltaFixture({
      revision: 9,
      transition: { kind: 'retry_pin_adopted', artifactHash: 'sha256:pin-2' },
    }),
  );
  assert.equal(currentArtifactHash(adopted), 'sha256:pin-2');
  assert.equal(
    currentArtifactHash(applySummary(adopted, workflowSummaryFixture({ revision: 9 }))),
    'sha256:pin-1',
  );
});

function t(seconds: number): string {
  return new Date(Date.UTC(2026, 8, 15, 10, 0, seconds)).toISOString();
}
