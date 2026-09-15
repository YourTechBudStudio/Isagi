import assert from 'node:assert/strict';
import test from 'node:test';

import { isWorkflowBranded } from './brand.js';
import {
  complete,
  eventGuards,
  suspend,
  wait,
  workflowWaitKinds,
  type NodeEvent,
} from './operations.js';

test('complete and suspend are branded, because the runtime switches on them across a bundle', () => {
  assert.ok(isWorkflowBranded(complete(), 'operation-result'));
  assert.ok(isWorkflowBranded(suspend({ wait: wait.userContinue() }), 'operation-result'));
});

test('an omitted update is an absent key, never an own undefined', () => {
  // The runtime rejects an own key whose value is undefined, so "no update" must not produce one.
  assert.equal(Object.hasOwn(complete(), 'update'), false);
  assert.equal(Object.hasOwn(complete({}), 'update'), false);
  assert.equal(Object.hasOwn(suspend({ wait: wait.userContinue() }), 'update'), false);
});

test('an explicitly supplied update is carried through', () => {
  const result = complete({ update: { reviewRound: 1 } });
  assert.equal(result.type, 'complete');
  assert.deepEqual(result.update, { reviewRound: 1 });
});

test('suspend carries both its update and its wait declaration', () => {
  const declaration = wait.userInput([{ kind: 'text', key: 'note', label: 'Note' }]);
  const result = suspend({ update: { reviewRound: 2 }, wait: declaration });
  assert.equal(result.type, 'suspend');
  assert.deepEqual(result.type === 'suspend' ? result.wait : null, declaration);
});

test('the wait kinds are exactly the four the runtime can arm', () => {
  assert.deepEqual(
    [...workflowWaitKinds],
    ['agent_turn', 'user_continue', 'user_input', 'headless_agent'],
  );
});

test('userContinue omits an absent label rather than recording undefined', () => {
  assert.deepEqual(wait.userContinue(), { kind: 'user_continue' });
  assert.deepEqual(wait.userContinue('Ship it'), { kind: 'user_continue', label: 'Ship it' });
});

test('headlessAgent normalizes one handle and preserves declared order', () => {
  assert.deepEqual(wait.headlessAgent({ operationId: 'a' }), {
    kind: 'headless_agent',
    operations: [{ operationId: 'a' }],
  });
  assert.deepEqual(wait.headlessAgent([{ operationId: 'b' }, { operationId: 'a' }]), {
    kind: 'headless_agent',
    operations: [{ operationId: 'b' }, { operationId: 'a' }],
  });
});

test('headlessAgent rejects an empty operation set', () => {
  assert.throws(() => wait.headlessAgent([]), /at least one operation/);
});

test('agentTurn carries the target the runtime correlates against', () => {
  const target = { agentSessionId: 7, sentAt: '2026-01-01T00:00:00.000Z' };
  assert.deepEqual(wait.agentTurn(target), { kind: 'agent_turn', target });
});

const headlessEvent: NodeEvent = {
  kind: 'headless_agent',
  results: [
    { operationId: 'judge', status: 'completed', output: 'pass' },
    { operationId: 'lint', status: 'failed', error: 'boom' },
  ],
};

test('the event guards narrow the kinds that carry real logic', () => {
  assert.ok(eventGuards.isHeadless(headlessEvent));
  assert.equal(eventGuards.isAgentTurn(headlessEvent), false);
  assert.ok(eventGuards.isAgentTurn({ kind: 'agent_turn', outcome: 'ended', recordedAt: 'now' }));
  assert.ok(
    eventGuards.isSubgraph({
      kind: 'subgraph',
      result: { outcomeId: 'complete', outcomeKind: 'success', output: null },
    }),
  );
});

test('requireHeadless resolves a member by id and explains both ways it can fail', () => {
  assert.equal(eventGuards.requireHeadless(headlessEvent, 'lint').status, 'failed');
  assert.throws(
    () => eventGuards.requireHeadless(headlessEvent, 'missing'),
    /no result for operation "missing"/,
  );
  assert.throws(
    () => eventGuards.requireHeadless({ kind: 'immediate' }, 'judge'),
    /Expected a headless agent event; received "immediate"/,
  );
});
