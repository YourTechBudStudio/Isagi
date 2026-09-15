import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isWorkflowBranded,
  type OperationContext,
  type WorkflowOrigin,
} from '@yourtechbudstudio/isagi-workflow-sdk';

import workflow, { MinimalGraph } from '../src/index.js';

// The minimal workflow never touches ctx, so an empty cast is enough. A real workflow's test would
// stub the ctx verbs its callbacks call (spawnAgentSession, runHeadlessAgent, ...).
const origin: WorkflowOrigin = { worktreeId: 1, worktreePath: '/tmp/wt', surfaceId: 1 };
const placement = { worktreeId: 1, worktreePath: '/tmp/wt', surfaceId: 1 };
const ctx = {} as unknown as OperationContext;

function operationNode(id: string) {
  const node = MinimalGraph.nodes[id];
  assert.ok(isWorkflowBranded(node, 'operation-node'), `${id} is an operation node`);
  return node;
}

test('command advertises the run and its single text input', async () => {
  const manifest = await workflow.command(origin);
  assert.equal(manifest.title, 'Minimal workflow');
  assert.deepEqual(
    (manifest.inputs ?? []).map((input) => input.key),
    ['note'],
  );
});

test('validate rejects an empty note', () => {
  assert.throws(() => workflow.validate(origin, { note: '' }), /non-empty string/);
});

test('init copies the note into serializable state', () => {
  assert.deepEqual(MinimalGraph.init(placement, { note: 'ship it' }), {
    note: 'ship it',
    acknowledged: false,
  });
});

test('the entry node suspends on a user-continue wait', async () => {
  const result = await operationNode('askForAck').run(ctx, MinimalGraph.init(placement, {}));
  assert.equal(result.type, 'suspend');
  assert.deepEqual(result.type === 'suspend' ? result.wait : undefined, {
    kind: 'user_continue',
    label: 'Continue',
  });
});

test('its router sends the delivered wait to the node that records it', () => {
  assert.deepEqual(
    MinimalGraph.edges.fromAskForAck!.choose(MinimalGraph.init(placement, {}), {
      kind: 'user_continue',
    }),
    { to: 'recordAck' },
  );
});

test('recording the acknowledgement updates only the field it names', async () => {
  const result = await operationNode('recordAck').run(ctx, MinimalGraph.init(placement, {}));
  assert.equal(result.type, 'complete');
  assert.deepEqual(result.update, { acknowledged: true });
});

test('the success outcome echoes the captured note', () => {
  assert.deepEqual(
    MinimalGraph.outcomes.acknowledged!.output({ note: 'ship it', acknowledged: true }),
    {
      note: 'ship it',
    },
  );
});

test('every declared destination is a node or an outcome in this graph', () => {
  const declared = new Set([
    ...Object.keys(MinimalGraph.nodes),
    ...Object.keys(MinimalGraph.outcomes),
  ]);
  for (const router of Object.values(MinimalGraph.edges)) {
    for (const destination of router.to) assert.ok(declared.has(destination), destination);
  }
});
