import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkflowContext, WorkflowLaunchContext } from '@yourtechbudstudio/isagi-workflow-sdk';

import workflow from '../src/index.js';

// The minimal workflow never touches ctx, so an empty cast is enough. A real workflow's test
// would stub the ctx verbs its reducer calls (spawnAgentSession, getConversationHistory, ...).
const launchCtx: WorkflowLaunchContext = { worktreeId: 1, worktreePath: '/tmp/wt', surfaceId: 1 };
const ctx = {} as unknown as WorkflowContext;

test('command advertises the run and its single text input', async () => {
  const manifest = await workflow.command(launchCtx);
  assert.equal(manifest.title, 'Minimal workflow');
  assert.deepEqual(
    (manifest.inputs ?? []).map((input) => input.key),
    ['note'],
  );
});

test('validate rejects an empty note', async () => {
  await assert.rejects(async () => {
    await workflow.validate(launchCtx, { note: '' });
  });
});

test('init copies the note into serializable state', async () => {
  const state = await workflow.init(launchCtx, { note: 'ship it' });
  assert.deepEqual(state, { stateVersion: 1, note: 'ship it', stage: { kind: 'await_ack' } });
});

test('the first step suspends on a user-continue wait', async () => {
  const state = await workflow.init(launchCtx, { note: 'ship it' });
  const result = await workflow.step(ctx, state, null);
  assert.equal(result.type, 'suspend');
  assert.deepEqual(result.type === 'suspend' ? result.condition : undefined, {
    kind: 'user_continue',
  });
});

test('continuing the run completes it with the captured note', async () => {
  const state = await workflow.init(launchCtx, { note: 'ship it' });
  const finished = await workflow.step(ctx, state, { kind: 'user_continue' });
  assert.equal(finished.type, 'done');
  assert.deepEqual(finished.type === 'done' ? finished.value : undefined, { note: 'ship it' });
});
