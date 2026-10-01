import assert from 'node:assert/strict';
import test from 'node:test';

import { codeReloads, pauseBands, retries, waitTimings } from './history.js';
import { workflowEventFixture as event } from './test-support.js';

test('a pause band runs from run_paused to the resume or cancel that ended it', () => {
  assert.deepEqual(
    pauseBands([
      event({ eventId: 1, kind: 'run_paused', at: 'a' }),
      event({ eventId: 2, kind: 'run_resumed', at: 'b' }),
      event({ eventId: 3, kind: 'run_paused', at: 'c' }),
      event({ eventId: 4, kind: 'run_cancelled', at: 'd' }),
      event({ eventId: 5, kind: 'run_paused', at: 'e' }),
    ]),
    [
      { start: 'a', end: 'b' },
      { start: 'c', end: 'd' },
      { start: 'e', end: null },
    ],
  );
});

test('reloads and retries are read from their own events', () => {
  const events = [
    event({ eventId: 1, kind: 'code_reloaded', at: 'a', data: { from: 'h1', to: 'h2' } }),
    event({ eventId: 2, kind: 'run_retried', at: 'b', executionId: 9, message: 'Retrying plan' }),
  ];
  assert.deepEqual(codeReloads(events), [{ eventId: 1, at: 'a', from: 'h1', to: 'h2' }]);
  assert.deepEqual(retries(events), [
    { eventId: 2, at: 'b', executionId: 9, message: 'Retrying plan' },
  ]);
});

test('a wait starts at node_waiting and ends at its first delivery', () => {
  const timings = waitTimings([
    event({ eventId: 1, kind: 'node_waiting', executionId: 4, at: 'a' }),
    event({ eventId: 2, kind: 'wait_delivered', executionId: 4, at: 'b' }),
    event({ eventId: 3, kind: 'node_waiting', executionId: 5, at: 'c' }),
  ]);
  assert.deepEqual(timings.get(4), { waitingAt: 'a', deliveredAt: 'b' });
  assert.deepEqual(timings.get(5), { waitingAt: 'c', deliveredAt: null });
});
