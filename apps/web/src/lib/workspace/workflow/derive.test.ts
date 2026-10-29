import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkflowRunSummary } from '@isagi/contracts';

import { workflowCopy } from '../../../copy/index.js';
import { workflowRunPresentation } from './derive.js';
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
  const agent = workflowRunPresentation(
    workflowSummaryFixture({
      status: 'waiting',
      current: current({ kind: 'agent_turn', target: { agentSessionId: 1, sentAt: 'x' } }),
    }),
  );
  assert.equal(agent.wait, null);
  assert.equal(agent.canAnswer, false);
  assert.equal(agent.status, 'driving');
  const asked = workflowRunPresentation(
    workflowSummaryFixture({
      status: 'waiting',
      current: current({ kind: 'user_continue', label: 'Fix it' }),
    }),
  );
  assert.equal(asked.wait?.kind, 'user_continue');
  assert.equal(asked.canAnswer, true);
  assert.equal(asked.status, 'waiting_user');
});

test('a paused run still takes an answer; a failed or cancelled one does not', () => {
  const wait = current({ kind: 'user_input', questions: [] });
  const canAnswer = (status: WorkflowRunSummary['status']) =>
    workflowRunPresentation(workflowSummaryFixture({ status, current: wait })).canAnswer;
  assert.equal(canAnswer('paused'), true);
  assert.equal(canAnswer('failed'), false);
  assert.equal(canAnswer('cancelled'), false);
});

test('the reason line speaks only while the environment is being prepared', () => {
  assert.equal(workflowRunPresentation(workflowSummaryFixture()).reason, null);
  assert.equal(
    workflowRunPresentation(workflowSummaryFixture({ status: 'preparing' })).reason,
    workflowCopy.preparing,
  );
});

test('a run that finished on a success outcome is done', () => {
  const view = workflowRunPresentation(
    workflowSummaryFixture({
      status: 'completed',
      outcome: { outcomeId: 'shipped', kind: 'success', reason: null },
    }),
  );
  assert.equal(view.status, 'done');
  assert.equal(view.tone, 'success');
  assert.equal(view.attention, null);
  assert.equal(view.failure, null);
});

test('a run that finished on a failure outcome reads as failed, with its own reason', () => {
  const controls = { pause: false, resume: false, retry: false, cancel: false, dismiss: true };
  const view = workflowRunPresentation(
    workflowSummaryFixture({
      status: 'completed',
      outcome: { outcomeId: 'broken', kind: 'failure', reason: 'Tests still fail' },
      controls,
    }),
  );
  assert.equal(view.status, 'failed');
  assert.equal(view.tone, 'error');
  assert.equal(view.label, 'Failed');
  assert.equal(view.attention, 'error');
  assert.deepEqual(view.failure, { kind: 'outcome', reason: 'Tests still fail' });
  // The runtime's controls pass through untouched, so no Retry appears for a finished run.
  assert.equal(view.controls, controls);
});

test('a failure outcome without a reason falls back to the shared copy', () => {
  const view = workflowRunPresentation(
    workflowSummaryFixture({
      status: 'completed',
      outcome: { outcomeId: 'broken', kind: 'failure', reason: null },
    }),
  );
  assert.deepEqual(view.failure, { kind: 'outcome', reason: workflowCopy.outcomeFailure });
});

test('a run whose step threw reads as failed and carries the error', () => {
  const error = {
    stage: 'node_function' as const,
    message: 'boom',
    graphKey: 'root',
    nodeId: 'build',
  };
  const view = workflowRunPresentation(workflowSummaryFixture({ status: 'failed', error }));
  assert.equal(view.status, 'failed');
  assert.equal(view.tone, 'error');
  assert.equal(view.attention, 'error');
  assert.deepEqual(view.failure, { kind: 'error', error });
});
