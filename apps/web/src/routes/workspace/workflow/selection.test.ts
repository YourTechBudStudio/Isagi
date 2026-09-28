import assert from 'node:assert/strict';
import test from 'node:test';

import { selectedExecutionId, selectionEquals, selectionResolves, visitsOf } from './selection.js';
import { instant, runViewFixture, visit } from './test-support.js';
import { addressKey } from './topology.js';

const draftKey = addressKey({ path: [], kind: 'node', id: 'draft' });

test('selecting a node selects its latest execution, which is what clicking it means', () => {
  const view = runViewFixture({
    executions: [
      visit({ executionId: 1, nodeId: 'draft', visitIndex: 0, startedAt: instant(1) }),
      visit({ executionId: 2, nodeId: 'draft', visitIndex: 1, startedAt: instant(5) }),
    ],
  });
  assert.equal(selectedExecutionId({ kind: 'element', key: draftKey }, view), 2);
  assert.deepEqual(
    visitsOf(view, draftKey).map((row) => row.executionId),
    [1, 2],
  );
});

test('a retry is another execution at the same address', () => {
  const view = runViewFixture({
    executions: [
      visit({ executionId: 1, nodeId: 'draft', status: 'failed', startedAt: instant(1) }),
      visit({ executionId: 2, nodeId: 'draft', retryOf: 1, startedAt: instant(3) }),
    ],
  });
  assert.deepEqual(
    visitsOf(view, draftKey).map((row) => row.executionId),
    [1, 2],
  );
});

test('a selection that names nothing this run has is dropped', () => {
  const view = runViewFixture({ executions: [] });
  assert.equal(selectionResolves({ kind: 'execution', executionId: 99 }, view), false);
  assert.equal(selectionResolves({ kind: 'invocation', invocationId: 99 }, view), false);
  assert.equal(selectionResolves({ kind: 'execution', executionId: 1 }, null), false);
  // A declared address is a position in a build, not a row, so it always resolves.
  assert.equal(selectionResolves({ kind: 'element', key: draftKey }, view), true);
  assert.equal(selectionResolves({ kind: 'invocation', invocationId: 1 }, view), true);
});

test('selections compare by kind and identity', () => {
  assert.equal(
    selectionEquals({ kind: 'execution', executionId: 1 }, { kind: 'invocation', invocationId: 1 }),
    false,
  );
  assert.equal(
    selectionEquals({ kind: 'execution', executionId: 1 }, { kind: 'execution', executionId: 1 }),
    true,
  );
  assert.equal(
    selectedExecutionId({ kind: 'invocation', invocationId: 1 }, runViewFixture({})),
    null,
  );
});
