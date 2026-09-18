import assert from 'node:assert/strict';
import test from 'node:test';

import { selectedExecutionId, selectionEquals, selectionResolves, visitsOf } from './selection.js';
import { instant, rootFrame, runStateFixture, visit } from './test-support.js';
import { addressKey } from './topology.js';

/**
 * Selection survives a pin change and does not survive a run change — two different questions.
 */

const draftKey = addressKey({ path: [], kind: 'node', id: 'draft' });

test('selecting a node selects its latest visit, which is what clicking it means', () => {
  const state = runStateFixture({
    executions: [
      visit({ executionId: 1, nodeId: 'draft', visitIndex: 0, startedAt: instant(1) }),
      visit({ executionId: 2, nodeId: 'draft', visitIndex: 1, startedAt: instant(5) }),
    ],
  });
  assert.equal(selectedExecutionId({ kind: 'element', key: draftKey }, state), 2);
  assert.deepEqual(
    visitsOf(state, draftKey).map((row) => row.executionId),
    [1, 2],
  );
});

/**
 * A Retry that adopts new code changes the *definition*, not the history. A selected visit is a
 * durable identity and stays selected, because the run still recorded it.
 */
test('a selected visit survives a pin change', () => {
  const state = runStateFixture({
    executions: [visit({ executionId: 1, nodeId: 'draft', latestArtifactHash: 'sha256:new' })],
  });
  assert.equal(selectionResolves({ kind: 'execution', executionId: 1 }, state), true);
});

test('a selection that names nothing this projection has is dropped', () => {
  const state = runStateFixture({ executions: [] });
  assert.equal(selectionResolves({ kind: 'execution', executionId: 99 }, state), false);
  assert.equal(selectionResolves({ kind: 'frame_output', frameId: 99 }, state), false);
  assert.equal(selectionResolves({ kind: 'execution', executionId: 1 }, null), false);
  // A declared address is a position in a definition, not a durable row, so it always resolves.
  assert.equal(selectionResolves({ kind: 'element', key: draftKey }, state), true);
});

test('a routing selection and an execution selection on the same visit are not the same selection', () => {
  assert.equal(
    selectionEquals({ kind: 'execution', executionId: 1 }, { kind: 'routing', executionId: 1 }),
    false,
  );
  assert.equal(
    selectionEquals({ kind: 'execution', executionId: 1 }, { kind: 'execution', executionId: 1 }),
    true,
  );
  assert.equal(
    selectionEquals(
      { kind: 'frame_segment', frameId: 1, segment: 'entry' },
      { kind: 'frame_segment', frameId: 1, segment: 'output' },
    ),
    false,
  );
});

test('a frame selection resolves against the frames the projection holds', () => {
  const state = runStateFixture({ frames: [rootFrame()], executions: [] });
  assert.equal(
    selectionResolves({ kind: 'frame_segment', frameId: 1, segment: 'entry' }, state),
    true,
  );
  assert.equal(selectedExecutionId({ kind: 'frame_output', frameId: 1 }, state), null);
});
