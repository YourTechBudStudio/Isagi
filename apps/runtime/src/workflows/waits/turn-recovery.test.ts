import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkflowRunPosition } from '@isagi/contracts';

import type { SourceAgentTurnWait } from './turn-recovery.js';
import { selectRetryTurnRecovery } from './turn-recovery.js';

const routingPosition: Extract<WorkflowRunPosition, { kind: 'routing' }> = {
  kind: 'routing',
  frameId: 1,
  executionId: 2,
  edgeId: 'prompt-out',
};

function source(outcome: 'ended' | 'failed'): SourceAgentTurnWait {
  return {
    waitId: 7,
    declaration: {
      kind: 'agent_turn',
      target: { agentSessionId: 500, sentAt: '2026-09-17T00:00:00.000Z' },
    },
    event:
      outcome === 'ended'
        ? { kind: 'agent_turn', outcome, recordedAt: '2026-09-17T00:00:02.000Z' }
        : {
            kind: 'agent_turn',
            outcome,
            recordedAt: '2026-09-17T00:00:02.000Z',
            reason: 'provider_error',
          },
  };
}

const originalEdges = [
  {
    type: 'turn_started' as const,
    agentSessionId: 500,
    harnessSessionId: 'native',
    seq: 1,
    recordedAt: '2026-09-17T00:00:01.000Z',
  },
  {
    type: 'turn_failed' as const,
    agentSessionId: 500,
    harnessSessionId: 'native',
    seq: 1,
    recordedAt: '2026-09-17T00:00:02.000Z',
    reason: 'provider_error',
  },
];

const laterEdges = [
  ...originalEdges,
  {
    type: 'turn_started' as const,
    agentSessionId: 500,
    harnessSessionId: 'native',
    seq: 2,
    recordedAt: '2026-09-17T00:00:03.000Z',
  },
  {
    type: 'turn_ended' as const,
    agentSessionId: 500,
    harnessSessionId: 'native',
    seq: 2,
    recordedAt: '2026-09-17T00:00:04.000Z',
  },
];

test('the pure recovery policy preserves saved producers and ordinary failed-turn retry', () => {
  assert.equal(
    selectRetryTurnRecovery({
      position: routingPosition,
      hasSavedProducerOutput: true,
      source: source('ended'),
      operations: [],
      edges: laterEdges,
      existingRecoveries: [],
    }),
    null,
  );
  assert.equal(
    selectRetryTurnRecovery({
      position: routingPosition,
      hasSavedProducerOutput: false,
      source: source('failed'),
      operations: [],
      edges: originalEdges,
      existingRecoveries: [],
    }),
    null,
  );
});

test('the pure recovery policy arms a newer exact turn and reuses the same selection', () => {
  const selected = selectRetryTurnRecovery({
    position: routingPosition,
    hasSavedProducerOutput: false,
    source: source('failed'),
    operations: [],
    edges: laterEdges,
    existingRecoveries: [],
  });
  assert.equal(selected?.kind, 'arm');
  assert.deepEqual(selected?.declaration.isagiRecovery.turn, {
    harnessSessionId: 'native',
    seq: 2,
    startedAt: '2026-09-17T00:00:03.000Z',
  });

  assert.equal(
    selectRetryTurnRecovery({
      position: routingPosition,
      hasSavedProducerOutput: false,
      source: source('failed'),
      operations: [],
      edges: laterEdges,
      existingRecoveries: selected ? [selected.declaration] : [],
    })?.kind,
    'reuse',
  );
});

test('a callback can recover only from a completed source turn', () => {
  assert.equal(
    selectRetryTurnRecovery({
      position: { kind: 'node_callback', frameId: 1, executionId: 3 },
      hasSavedProducerOutput: false,
      source: source('failed'),
      operations: [],
      edges: laterEdges,
      existingRecoveries: [],
    }),
    null,
  );
});
