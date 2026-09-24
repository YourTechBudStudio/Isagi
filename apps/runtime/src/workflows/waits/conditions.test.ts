import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findSatisfiedTerminalTurnEdge,
  hasInFlightTurn,
  selectTurnAssociation,
  terminalForFixedAssociation,
  type WorkflowObservedTurnEdge,
} from './conditions.js';

const boundary = { agentSessionId: 10, sentAt: '2026-06-18T00:00:10.000Z' };

function started(input: {
  seq: number | null;
  at: string;
  harnessSessionId?: string;
}): WorkflowObservedTurnEdge {
  return {
    type: 'turn_started',
    agentSessionId: 10,
    harnessSessionId: input.harnessSessionId ?? 'harness-a',
    seq: input.seq,
    recordedAt: input.at,
  };
}

function ended(input: {
  seq: number | null;
  at: string;
  harnessSessionId?: string;
}): WorkflowObservedTurnEdge {
  return {
    type: 'turn_ended',
    agentSessionId: 10,
    harnessSessionId: input.harnessSessionId ?? 'harness-a',
    seq: input.seq,
    recordedAt: input.at,
  };
}

function failed(input: {
  seq: number | null;
  at: string;
  reason: string;
  harnessSessionId?: string;
}): WorkflowObservedTurnEdge {
  return {
    type: 'turn_failed',
    agentSessionId: 10,
    harnessSessionId: input.harnessSessionId ?? 'harness-a',
    seq: input.seq,
    recordedAt: input.at,
    reason: input.reason,
  };
}

test('turn wait satisfaction requires a matching start after the wait watermark', () => {
  const edge = findSatisfiedTerminalTurnEdge(boundary, [
    started({ seq: 1, at: '2026-06-18T00:00:09.000Z' }),
    ended({ seq: 1, at: '2026-06-18T00:00:11.000Z' }),
  ]);

  assert.equal(edge, null);
});

test('a turn that started before the watermark is not ours, which is why the operation timestamp is not a substitute', () => {
  assert.deepEqual(
    selectTurnAssociation(boundary, [started({ seq: 1, at: '2026-06-18T00:00:09.999Z' })]),
    { kind: 'pending' },
  );
});

test('turn wait satisfaction uses seq pairing when terminal edges arrive after the watermark', () => {
  const edge = findSatisfiedTerminalTurnEdge(boundary, [
    started({ seq: 1, at: '2026-06-18T00:00:09.000Z' }),
    started({ seq: 2, at: '2026-06-18T00:00:10.100Z' }),
    ended({ seq: 1, at: '2026-06-18T00:00:11.000Z' }),
    ended({ seq: 2, at: '2026-06-18T00:00:12.000Z' }),
  ]);

  assert.equal(edge?.recordedAt, '2026-06-18T00:00:12.000Z');
});

test('turn wait follows the first post-submit start across a changed harness session', () => {
  const edge = findSatisfiedTerminalTurnEdge(boundary, [
    started({
      seq: 0,
      at: '2026-06-18T00:00:10.100Z',
      harnessSessionId: 'harness-after-slash-new',
    }),
    ended({ seq: 0, at: '2026-06-18T00:00:12.000Z', harnessSessionId: 'harness-after-slash-new' }),
  ]);

  assert.equal(edge?.harnessSessionId, 'harness-after-slash-new');
});

test('two competing starts with the first still unexplained are ambiguous, not a later winner', () => {
  // The old evaluator answered "keep waiting" here, which is indistinguishable from "nothing has
  // happened yet". It is not the same fact: a second start our prompt cannot account for means the
  // runtime does not know which turn it caused, and that has to block rather than resolve later on
  // whichever edge happens to arrive.
  const edges = [
    started({ seq: 0, at: '2026-06-18T00:00:10.100Z', harnessSessionId: 'original-harness' }),
    started({ seq: 0, at: '2026-06-18T00:00:11.000Z', harnessSessionId: 'replacement-harness' }),
    ended({ seq: 0, at: '2026-06-18T00:00:12.000Z', harnessSessionId: 'replacement-harness' }),
  ];
  assert.deepEqual(selectTurnAssociation(boundary, edges), { kind: 'ambiguous', startCount: 2 });
  assert.equal(findSatisfiedTerminalTurnEdge(boundary, edges), null);
});

test('a second start that supersedes the first is a confirmed interruption, not ambiguity', () => {
  // The case `reducePiLifecycle` actually produces: a new start interrupts an active turn and emits
  // a `turn_failed` carrying the *superseded* turn's seq. Counting subsequent starts blindly would
  // discard that confirmed terminal and block a run the runtime can fully explain.
  const edges = [
    started({ seq: 1, at: '2026-06-18T00:00:10.100Z' }),
    started({ seq: 2, at: '2026-06-18T00:00:11.000Z' }),
    failed({ seq: 1, at: '2026-06-18T00:00:11.000Z', reason: 'new_start_supersedes' }),
  ];
  const association = selectTurnAssociation(boundary, edges);
  assert.equal(association.kind, 'fixed');
  assert.equal(association.kind === 'fixed' && association.startSeq, 1);
  assert.equal(association.kind === 'fixed' && association.attribution, 'inferred_by_watermark');

  const terminal = findSatisfiedTerminalTurnEdge(boundary, edges);
  assert.equal(terminal?.type, 'turn_failed');
  assert.equal(terminal?.reason, 'new_start_supersedes');
});

test('a fixed association ignores later starts and later session activity entirely', () => {
  const fixed = {
    agentSessionId: 10,
    sentAt: boundary.sentAt,
    harnessSessionId: 'harness-a',
    startSeq: 1,
  };
  const terminal = terminalForFixedAssociation(fixed, [
    started({ seq: 1, at: '2026-06-18T00:00:10.100Z' }),
    ended({ seq: 1, at: '2026-06-18T00:00:11.000Z' }),
    started({ seq: 2, at: '2026-06-18T00:00:20.000Z' }),
    ended({ seq: 2, at: '2026-06-18T00:00:30.000Z' }),
  ]);
  assert.equal(terminal?.seq, 1);
  assert.equal(terminal?.recordedAt, '2026-06-18T00:00:11.000Z');
});

test('turn wait satisfaction falls back to chronological pairing for null seq terminals', () => {
  const edge = findSatisfiedTerminalTurnEdge(boundary, [
    started({ seq: 2, at: '2026-06-18T00:00:10.100Z' }),
    failed({ seq: null, at: '2026-06-18T00:00:10.100Z', reason: 'session_died' }),
  ]);

  assert.equal(edge?.type, 'turn_failed');
  assert.equal(edge?.reason, 'session_died');
});

test('numeric terminal edges never fall back to a different opening sequence', () => {
  const edge = findSatisfiedTerminalTurnEdge(boundary, [
    started({ seq: 2, at: '2026-06-18T00:00:10.100Z' }),
    ended({ seq: 3, at: '2026-06-18T00:00:11.000Z' }),
  ]);
  assert.equal(edge, null);
});

test('an older sticky failure cannot close a newer active turn in the same harness session', () => {
  assert.equal(
    hasInFlightTurn([
      started({ seq: 1, at: '2026-06-18T00:00:10.000Z' }),
      started({ seq: 2, at: '2026-06-18T00:00:11.000Z' }),
      failed({ seq: 1, at: '2026-06-18T00:00:10.000Z', reason: 'session_died' }),
    ]),
    true,
  );
});

test('selection is a classification over evidence the evaluator already reads', () => {
  assert.deepEqual(selectTurnAssociation(boundary, []), { kind: 'pending' });
  assert.equal(hasInFlightTurn([]), false);
});
