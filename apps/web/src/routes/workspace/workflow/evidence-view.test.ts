import assert from 'node:assert/strict';
import test from 'node:test';

import { workflowEvidenceFixture } from '../../../lib/workspace/workflow/test-support.js';
import {
  buildEvidenceTree,
  evidenceFacets,
  filterEvidence,
  type EvidenceGroup,
} from './evidence-view.js';
import { nested, rootFrame, runStateFixture, visit } from './test-support.js';

/**
 * Grouping a flat listing back into the shape the run actually had.
 *
 * The route knows nothing about ancestry, so everything these tests protect is derived on the
 * client: that a nested capture is shown *inside* the subgraph visit that contains it rather than
 * beside it, that a subgraph group's number is subtree-inclusive, that capture order survives the
 * grouping, and that a record whose execution has not arrived is still on screen.
 */

/**
 * A root frame with two visits, one of them a subgraph whose child frame holds two more.
 *
 *   #1 discover
 *   #2 phase (subgraph)  →  frame 2
 *        #3 implement
 *        #4 review
 */
function world() {
  return runStateFixture({
    frames: [
      rootFrame(),
      nested({ frameId: 2, parentExecutionId: 2, parentFrameId: 1, graphKey: 'phase', depth: 1 }),
    ],
    executions: [
      visit({ executionId: 1, frameId: 1, nodeId: 'discover' }),
      visit({
        executionId: 2,
        frameId: 1,
        nodeId: 'phase',
        nodeKind: 'subgraph',
        childFrameId: 2,
        displayName: 'Phase 2',
      }),
      visit({ executionId: 3, frameId: 2, nodeId: 'implement' }),
      visit({ executionId: 4, frameId: 2, nodeId: 'review' }),
    ],
  });
}

const record = (evidenceKey: string, executionId: number, extra = {}) =>
  workflowEvidenceFixture({ evidenceKey, executionId, ...extra });

test('a subgraph visit contains the captures made inside it, and counts them subtree-wide', () => {
  const tree = buildEvidenceTree({
    state: world(),
    records: [record('a', 1), record('b', 3), record('c', 4), record('d', 3)],
    rootExecutionId: null,
    liveExecutionId: null,
  });

  assert.deepEqual(
    tree.groups.map((group) => group.executionId),
    [1, 2],
  );
  const [discover, phase] = tree.groups as [EvidenceGroup, EvidenceGroup];

  // The subgraph visit captured nothing itself. Everything under it is in its children.
  assert.deepEqual(phase.records, []);
  assert.deepEqual(
    phase.children.map((child) => child.executionId),
    [3, 4],
  );
  assert.equal(phase.total, 3);
  assert.equal(phase.isSubgraph, true);
  assert.equal(phase.depth, 0);
  assert.equal(phase.children[0]?.depth, 1);

  // Flattening would have put b, c and d beside a. Nothing here does.
  assert.deepEqual(
    discover.records.map((item) => item.evidenceKey),
    ['a'],
  );
  assert.equal(discover.total, 1);
  assert.equal(tree.placed, 4);
});

test('siblings keep capture order, rather than execution order', () => {
  // #4 captured before #3 did. Ordering groups by execution id would silently reorder history.
  const tree = buildEvidenceTree({
    state: world(),
    records: [record('first', 4), record('second', 3)],
    rootExecutionId: null,
    liveExecutionId: null,
  });
  assert.deepEqual(
    tree.groups[0]?.children.map((child) => child.executionId),
    [4, 3],
  );
});

test('a live visit with nothing captured is a line, never an empty group', () => {
  const tree = buildEvidenceTree({
    state: world(),
    records: [record('a', 1)],
    rootExecutionId: null,
    liveExecutionId: 3,
  });

  const phase = tree.groups.find((group) => group.executionId === 2);
  const live = phase?.children[0];
  assert.equal(live?.executionId, 3);
  assert.equal(live?.live, true);
  assert.deepEqual(live?.records, []);

  // A visit that is live *and* has captured something is an ordinary group: marking it would
  // replace its records with a line claiming it has none.
  const withCaptures = buildEvidenceTree({
    state: world(),
    records: [record('a', 3)],
    rootExecutionId: null,
    liveExecutionId: 3,
  });
  assert.equal(withCaptures.groups[0]?.children[0]?.live, false);
});

test('visit scope roots the tree at one visit, and shows it even when empty', () => {
  const tree = buildEvidenceTree({
    state: world(),
    // A capture in a sibling branch of the run must not appear under this root.
    records: [record('inside', 3), record('elsewhere', 1)],
    rootExecutionId: 2,
    liveExecutionId: null,
  });

  assert.deepEqual(
    tree.groups.map((group) => group.executionId),
    [2],
  );
  assert.equal(tree.groups[0]?.total, 1);
  // `elsewhere` belongs to another branch entirely. It is dropped rather than misplaced, and it is
  // *not* reported as unplaced: unplaced means "exists and has nowhere to sit yet", which is a
  // different problem with a different remedy.
  assert.deepEqual(tree.unplaced, []);
  assert.equal(tree.placed, 1);

  const empty = buildEvidenceTree({
    state: world(),
    records: [],
    rootExecutionId: 4,
    liveExecutionId: null,
  });
  assert.deepEqual(
    empty.groups.map((group) => group.executionId),
    [4],
  );
  assert.equal(empty.groups[0]?.total, 0);
});

test('a record whose execution has not arrived is shown, not dropped', () => {
  // Reachable mid-hydration: the listing and the projection are two reads. Understating what a run
  // captured is the one thing this surface may never do.
  const tree = buildEvidenceTree({
    state: world(),
    records: [record('ghost', 99), record('a', 1)],
    rootExecutionId: null,
    liveExecutionId: null,
  });
  assert.deepEqual(
    tree.unplaced.map((item) => item.evidenceKey),
    ['ghost'],
  );
  assert.equal(tree.placed, 1);
});

test('facets come from the records in hand, in first-seen order', () => {
  const records = [
    record('a', 1, { role: 'review-feedback', labels: { round: 1, phase: 2 } }),
    record('b', 1, { role: 'fixer-response', labels: { round: 1 } }),
    record('c', 1, { role: 'review-feedback', labels: { round: 2, phase: 2 } }),
  ];
  const facets = evidenceFacets(records);
  assert.deepEqual(facets.roles, ['review-feedback', 'fixer-response']);
  assert.deepEqual(facets.labels, ['round:1', 'phase:2', 'round:2']);
});

test('chips narrow: every selected label must match, and role and labels compose', () => {
  const records = [
    record('a', 1, { role: 'review-feedback', labels: { round: 1, phase: 2 } }),
    record('b', 1, { role: 'review-feedback', labels: { round: 2, phase: 2 } }),
    record('c', 1, { role: 'fixer-response', labels: { round: 1, phase: 2 } }),
  ];

  assert.deepEqual(
    filterEvidence(records, { role: null, labels: new Set(['phase:2', 'round:1']) }).map(
      (item) => item.evidenceKey,
    ),
    ['a', 'c'],
  );
  assert.deepEqual(
    filterEvidence(records, { role: 'review-feedback', labels: new Set(['round:1']) }).map(
      (item) => item.evidenceKey,
    ),
    ['a'],
  );
  // No filters is the identity, and returns the same array rather than a copy.
  assert.equal(filterEvidence(records, { role: null, labels: new Set() }), records);
});
