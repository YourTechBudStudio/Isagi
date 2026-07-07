import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkflowWaitCondition } from './types.js';
import { findSatisfiedTerminalTurnEdge } from './wait-conditions.js';

const condition = {
  kind: 'agent_turn',
  agentSessionId: 10,
  harnessSessionId: 'harness-a',
  sentAt: '2026-06-18T00:00:10.000Z',
} satisfies WorkflowWaitCondition;

test('turn wait satisfaction requires a matching start after the wait watermark', () => {
  const edge = findSatisfiedTerminalTurnEdge(condition, [
    {
      type: 'turn_started',
      agentSessionId: 10,
      harnessSessionId: 'harness-a',
      seq: 1,
      recordedAt: '2026-06-18T00:00:09.000Z',
    },
    {
      type: 'turn_ended',
      agentSessionId: 10,
      harnessSessionId: 'harness-a',
      seq: 1,
      recordedAt: '2026-06-18T00:00:11.000Z',
    },
  ]);

  assert.equal(edge, null);
});

test('turn wait satisfaction uses seq pairing when terminal edges arrive after the watermark', () => {
  const edge = findSatisfiedTerminalTurnEdge(condition, [
    {
      type: 'turn_started',
      agentSessionId: 10,
      harnessSessionId: 'harness-a',
      seq: 1,
      recordedAt: '2026-06-18T00:00:09.000Z',
    },
    {
      type: 'turn_started',
      agentSessionId: 10,
      harnessSessionId: 'harness-a',
      seq: 2,
      recordedAt: '2026-06-18T00:00:10.100Z',
    },
    {
      type: 'turn_ended',
      agentSessionId: 10,
      harnessSessionId: 'harness-a',
      seq: 1,
      recordedAt: '2026-06-18T00:00:11.000Z',
    },
    {
      type: 'turn_ended',
      agentSessionId: 10,
      harnessSessionId: 'harness-a',
      seq: 2,
      recordedAt: '2026-06-18T00:00:12.000Z',
    },
  ]);

  assert.equal(edge?.recordedAt, '2026-06-18T00:00:12.000Z');
});

test('turn wait satisfaction falls back to chronological pairing for null seq terminals', () => {
  const edge = findSatisfiedTerminalTurnEdge(condition, [
    {
      type: 'turn_started',
      agentSessionId: 10,
      harnessSessionId: 'harness-a',
      seq: 2,
      recordedAt: '2026-06-18T00:00:10.100Z',
    },
    {
      type: 'turn_failed',
      agentSessionId: 10,
      harnessSessionId: 'harness-a',
      seq: null,
      recordedAt: '2026-06-18T00:00:10.100Z',
      reason: 'new_start_supersedes',
    },
  ]);

  assert.equal(edge?.type, 'turn_failed');
  assert.equal(edge?.reason, 'new_start_supersedes');
});
