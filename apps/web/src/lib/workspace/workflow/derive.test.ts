import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkflowRunSummary } from '@isagi/contracts';

import { workflowCopy } from '../../../copy/index.js';
import { canAnswer, userWait, workflowReasonLine } from './derive.js';
import { workflowSummaryFixture } from './test-support.js';

const current = (
  wait: NonNullable<WorkflowRunSummary['current']>['wait'],
): WorkflowRunSummary['current'] => ({
  executionId: 3,
  invocationId: 1,
  graphKey: 'root',
  nodeId: 'ask',
  nodeKind: 'operation',
  label: null,
  wait,
});

test('only a user wait asks the person something', () => {
  const agent = workflowSummaryFixture({
    status: 'waiting',
    current: current({ kind: 'agent_turn', target: { agentSessionId: 1, sentAt: 'x' } }),
  });
  assert.equal(userWait(agent), null);
  assert.equal(canAnswer(agent), false);
  const asked = workflowSummaryFixture({
    status: 'waiting',
    current: current({ kind: 'user_continue', label: 'Fix it' }),
  });
  assert.equal(userWait(asked)?.kind, 'user_continue');
  assert.equal(canAnswer(asked), true);
});

test('a paused run still takes an answer; a failed or cancelled one does not', () => {
  const wait = current({ kind: 'user_input', questions: [] });
  assert.equal(canAnswer(workflowSummaryFixture({ status: 'paused', current: wait })), true);
  assert.equal(canAnswer(workflowSummaryFixture({ status: 'failed', current: wait })), false);
  assert.equal(canAnswer(workflowSummaryFixture({ status: 'cancelled', current: wait })), false);
});

test('the reason line speaks only while the environment is being prepared', () => {
  assert.equal(workflowReasonLine(workflowSummaryFixture()), null);
  assert.equal(
    workflowReasonLine(workflowSummaryFixture({ status: 'preparing' })),
    workflowCopy.preparing,
  );
});
