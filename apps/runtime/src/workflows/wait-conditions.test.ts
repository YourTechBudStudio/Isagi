import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkflowWaitCondition } from './types.js';
import { findSatisfiedTerminalTurnEdge, hasInFlightTurn } from './wait-conditions.js';

const condition = {
  kind: 'agent_turn',
  agentSessionId: 10,
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

test('turn wait follows the first post-submit start across a changed harness session', () => {
  const edge = findSatisfiedTerminalTurnEdge(condition, [
    {
      type: 'turn_started',
      agentSessionId: 10,
      harnessSessionId: 'harness-after-slash-new',
      seq: 0,
      recordedAt: '2026-06-18T00:00:10.100Z',
    },
    {
      type: 'turn_ended',
      agentSessionId: 10,
      harnessSessionId: 'harness-after-slash-new',
      seq: 0,
      recordedAt: '2026-06-18T00:00:12.000Z',
    },
  ]);

  assert.equal(edge?.harnessSessionId, 'harness-after-slash-new');
});

test('a later completed turn cannot steal a wait from its unresolved first start', () => {
  const edge = findSatisfiedTerminalTurnEdge(condition, [
    {
      type: 'turn_started',
      agentSessionId: 10,
      harnessSessionId: 'original-harness',
      seq: 0,
      recordedAt: '2026-06-18T00:00:10.100Z',
    },
    {
      type: 'turn_started',
      agentSessionId: 10,
      harnessSessionId: 'replacement-harness',
      seq: 0,
      recordedAt: '2026-06-18T00:00:11.000Z',
    },
    {
      type: 'turn_ended',
      agentSessionId: 10,
      harnessSessionId: 'replacement-harness',
      seq: 0,
      recordedAt: '2026-06-18T00:00:12.000Z',
    },
  ]);

  assert.equal(edge, null);
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
      reason: 'session_died',
    },
  ]);

  assert.equal(edge?.type, 'turn_failed');
  assert.equal(edge?.reason, 'session_died');
});

test('numeric terminal edges never fall back to a different opening sequence', () => {
  const edge = findSatisfiedTerminalTurnEdge(condition, [
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
      seq: 3,
      recordedAt: '2026-06-18T00:00:11.000Z',
    },
  ]);
  assert.equal(edge, null);
});

test('an older sticky failure cannot close a newer active turn in the same harness session', () => {
  assert.equal(
    hasInFlightTurn([
      {
        type: 'turn_started',
        agentSessionId: 10,
        harnessSessionId: 'harness-a',
        seq: 1,
        recordedAt: '2026-06-18T00:00:10.000Z',
      },
      {
        type: 'turn_started',
        agentSessionId: 10,
        harnessSessionId: 'harness-a',
        seq: 2,
        recordedAt: '2026-06-18T00:00:11.000Z',
      },
      {
        type: 'turn_failed',
        agentSessionId: 10,
        harnessSessionId: 'harness-a',
        seq: 1,
        recordedAt: '2026-06-18T00:00:10.000Z',
        reason: 'session_died',
      },
    ]),
    true,
  );
});
