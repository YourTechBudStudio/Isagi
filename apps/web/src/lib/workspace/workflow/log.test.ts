import assert from 'node:assert/strict';
import test from 'node:test';

import { workflowLogLines } from './log.js';
import { workflowEventFixture as event } from './test-support.js';

test('the log is the run’s log and ui_feedback events, and nothing else', () => {
  const lines = workflowLogLines([
    event({ eventId: 1, kind: 'node_started' }),
    event({
      eventId: 2,
      category: 'log',
      kind: 'log',
      data: { level: 'warning', message: 'careful' },
    }),
    event({
      eventId: 3,
      category: 'ui',
      kind: 'ui_feedback',
      data: { kind: 'error', phase: 'Review' },
    }),
  ]);
  assert.deepEqual(
    lines.map((line) => [line.eventId, line.label, line.tone, line.body]),
    [
      [2, 'log', 'warning', 'careful'],
      [3, 'feedback', 'error', 'Review'],
    ],
  );
});

test('a log line whose data is not the expected shape falls back to the event message', () => {
  const [line] = workflowLogLines([
    event({ eventId: 1, category: 'log', kind: 'log', message: 'raw', data: 'nope' }),
  ]);
  assert.equal(line?.body, 'raw');
  assert.equal(line?.tone, 'info');
});
