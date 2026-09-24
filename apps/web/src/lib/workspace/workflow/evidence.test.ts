import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkflowExecutionDto, WorkflowFrameDto } from '@isagi/contracts';

import {
  contentPresentation,
  evidenceCountForVisit,
  evidenceListQuery,
  evidenceQueryIdentity,
  evidenceRefreshSignal,
} from './evidence.js';
import { emptyRunState, type WorkflowRunState } from './model.js';
import { workflowExecutionFixture, workflowFrameFixture } from './test-support.js';

/**
 * The two readings of a subtree-inclusive count, and the one that is forbidden.
 *
 * Every assertion here exists because the obvious implementation — sum every execution — is wrong in
 * a way nothing would reveal until a run nested two levels deep reported a number nobody could
 * explain.
 */

/**
 * A root frame with a leaf visit (2 captures) and a subgraph visit (1 of its own, 2 beneath), whose
 * child frame holds two nested executions reporting 1 and 2.
 */
function state(): WorkflowRunState {
  const frames: WorkflowFrameDto[] = [
    workflowFrameFixture({ frameId: 1, parentExecutionId: null, depth: 0 }),
    workflowFrameFixture({
      frameId: 2,
      parentExecutionId: 20,
      parentFrameId: 1,
      graphKey: 'review',
      depth: 1,
    }),
  ];
  const executions: WorkflowExecutionDto[] = [
    execution({ executionId: 10, frameId: 1, nodeId: 'writer', captured: 2 }),
    execution({ executionId: 20, frameId: 1, nodeId: 'review', captured: 3, childFrameId: 2 }),
    execution({ executionId: 30, frameId: 2, nodeId: 'judge', captured: 1 }),
    execution({ executionId: 31, frameId: 2, nodeId: 'scribe', captured: 2 }),
  ];
  return {
    ...emptyRunState(7),
    hydrated: true,
    frames: new Map(frames.map((frame) => [frame.frameId, frame])),
    executions: new Map(executions.map((item) => [item.executionId, item])),
    executionOrder: executions.map((item) => item.executionId),
  };
}

function execution(input: {
  readonly executionId: number;
  readonly frameId: number;
  readonly nodeId: string;
  readonly captured: number;
  readonly childFrameId?: number;
  readonly visitIndex?: number;
}): WorkflowExecutionDto {
  return workflowExecutionFixture({
    executionId: input.executionId,
    frameId: input.frameId,
    nodeId: input.nodeId,
    visitIndex: input.visitIndex ?? 0,
    childFrameId: input.childFrameId ?? null,
    operationSummary: {
      count: input.captured,
      unresolved: 0,
      evidenceCaptured: input.captured,
      capabilities: ['capture_evidence'],
    },
  });
}

test('a visit reads its own subtree-inclusive count, and the run sums only the root frame', () => {
  const current = state();

  assert.equal(evidenceCountForVisit(current, 10), 2, 'a leaf visit reports its own captures');
  assert.equal(
    evidenceCountForVisit(current, 20),
    3,
    'a subgraph visit already includes everything beneath it',
  );
  assert.equal(evidenceCountForVisit(current, 31), 2);

  assert.equal(
    evidenceRefreshSignal(current, { kind: 'run' }),
    5,
    'the run total is 2 + 3: the root frame partitions the run, so nothing is counted twice',
  );

  // The forbidden reading, stated so the difference is visible rather than implied.
  const summedEverything = [...current.executions.values()].reduce(
    (total, item) => total + item.operationSummary.evidenceCaptured,
    0,
  );
  assert.equal(
    summedEverything,
    8,
    'summing every execution double-counts the nested captures the subgraph visit already includes',
  );
});

test('a visit scope reads one execution, and a looped node reads the visit it names', () => {
  const current = state();
  const withSecondVisit: WorkflowRunState = {
    ...current,
    executions: new Map(current.executions).set(
      11,
      execution({ executionId: 11, frameId: 1, nodeId: 'writer', visitIndex: 1, captured: 4 }),
    ),
  };

  assert.equal(
    evidenceRefreshSignal(withSecondVisit, { kind: 'visit', executionId: 10, subtree: true }),
    2,
  );
  assert.equal(
    evidenceRefreshSignal(withSecondVisit, { kind: 'visit', executionId: 11, subtree: true }),
    4,
    "a looped node's second visit reports that visit alone, never the element's total",
  );
  assert.equal(evidenceCountForVisit(withSecondVisit, 11), 4);
  assert.equal(
    evidenceCountForVisit(withSecondVisit, 999),
    0,
    'an execution the projection has not delivered counts as nothing, not as an error',
  );
});

test('the refresh signal is unmoved by a capture that has not committed', () => {
  const current = state();
  const scope = { kind: 'visit', executionId: 10, subtree: true } as const;
  const before = evidenceRefreshSignal(current, scope);

  // `intended` -> `abandoned` is the ordinary retry path. `count` and `unresolved` both move across
  // it while no evidence row exists, which is exactly why neither can serve as this signal.
  const abandoned: WorkflowRunState = {
    ...current,
    executions: new Map(current.executions).set(10, {
      ...current.executions.get(10)!,
      operationSummary: {
        count: 3,
        unresolved: 0,
        evidenceCaptured: 2,
        capabilities: ['capture_evidence'],
      },
    }),
  };
  assert.equal(evidenceRefreshSignal(abandoned, scope), before, 'no new record, no refetch');

  const committed: WorkflowRunState = {
    ...current,
    executions: new Map(current.executions).set(10, {
      ...current.executions.get(10)!,
      operationSummary: {
        count: 3,
        unresolved: 0,
        evidenceCaptured: 3,
        capabilities: ['capture_evidence'],
      },
    }),
  };
  assert.notEqual(
    evidenceRefreshSignal(committed, scope),
    before,
    'and the commit that writes the row is what moves it',
  );
});

test('a run with nothing captured, and no state at all, both read as zero', () => {
  assert.equal(evidenceRefreshSignal(null, { kind: 'run' }), 0);
  assert.equal(evidenceRefreshSignal(emptyRunState(7), { kind: 'run' }), 0);
});

test('a scope and its filters produce one query and one stable identity', () => {
  const scope = { kind: 'visit', executionId: 20, subtree: true } as const;
  assert.deepEqual(
    evidenceListQuery(scope, { role: 'review', label: ['round:2'] }, { limit: 100, cursor: null }),
    { limit: 100, executionId: 20, subtree: 'true', role: 'review', label: ['round:2'] },
  );
  assert.deepEqual(
    evidenceListQuery({ kind: 'run' }, {}, { limit: 50, cursor: 'abc' }),
    { limit: 50, cursor: 'abc' },
    'a run listing names no execution, and an absent filter is absent rather than undefined',
  );
  assert.deepEqual(
    evidenceListQuery(
      { kind: 'visit', executionId: 20, subtree: false },
      {},
      { limit: 100, cursor: null },
    ),
    { limit: 100, executionId: 20 },
    'subtree is sent only when it is on, so the contract never sees it without an execution',
  );

  // Label order must not split one cache entry in two.
  assert.equal(
    evidenceQueryIdentity(scope, { label: ['b:2', 'a:1'] }),
    evidenceQueryIdentity(scope, { label: ['a:1', 'b:2'] }),
  );
  assert.notEqual(
    evidenceQueryIdentity(scope, { role: 'review' }),
    evidenceQueryIdentity(scope, { role: 'verdict' }),
  );
  assert.notEqual(
    evidenceQueryIdentity(scope, {}),
    evidenceQueryIdentity({ kind: 'visit', executionId: 20, subtree: false }, {}),
  );
});

test('how a capture is shown follows its media type, and falls back to a download', () => {
  assert.equal(contentPresentation('text/markdown'), 'text');
  assert.equal(contentPresentation('text/plain; charset=utf-8'), 'text');
  assert.equal(contentPresentation('application/json'), 'json');
  assert.equal(contentPresentation('application/vnd.api+json'), 'json');
  assert.equal(contentPresentation('text/html'), 'html');
  assert.equal(contentPresentation('image/png'), 'image');
  // SVG is an image that is also a document, so it takes the sandboxed path rather than `<img>`.
  assert.equal(contentPresentation('image/svg+xml'), 'html');
  assert.equal(contentPresentation('application/pdf'), 'download');
  assert.equal(contentPresentation('application/octet-stream'), 'download');
});
