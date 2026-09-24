import assert from 'node:assert/strict';
import test from 'node:test';

import { checkpointRefreshSignal } from './checkpoints.js';
import { emptyRunState } from './model.js';
import { workflowExecutionFixture } from './test-support.js';

test('the checkpoint list signal counts visits that saved one, at any depth, once each', () => {
  assert.equal(checkpointRefreshSignal(null), 0);
  const saved = {
    checkpointId: 'wcp_1',
    title: 'Saved',
    base: { kind: 'none', reason: 'folder_project' },
    counts: { scopes: 1, files: 2, absences: 0, warnings: 0 },
  } as const;
  const state = {
    ...emptyRunState(7),
    executions: new Map([
      [1, workflowExecutionFixture({ executionId: 1, nodeKind: 'checkpoint', checkpoint: saved })],
      // A failed or pending capture saved nothing.
      [2, workflowExecutionFixture({ executionId: 2, nodeKind: 'checkpoint', checkpoint: null })],
      [
        3,
        workflowExecutionFixture({
          executionId: 3,
          frameId: 9,
          nodeKind: 'checkpoint',
          checkpoint: { ...saved, checkpointId: 'wcp_2' },
        }),
      ],
      [4, workflowExecutionFixture({ executionId: 4 })],
    ]),
  };
  assert.equal(checkpointRefreshSignal(state), 2);
});
