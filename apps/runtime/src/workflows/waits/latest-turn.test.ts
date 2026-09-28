import assert from 'node:assert/strict';
import test from 'node:test';

import { latestTurn, type TurnEdge } from './latest-turn.js';

const target = { agentSessionId: 7, sentAt: '2026-01-01T00:00:10.000Z' };

const start = (seq: number, second: number): TurnEdge => ({
  type: 'turn_started',
  agentSessionId: 7,
  harnessSessionId: 'h1',
  seq,
  recordedAt: `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`,
});
const end = (seq: number, second: number): TurnEdge => ({
  type: 'turn_ended',
  agentSessionId: 7,
  harnessSessionId: 'h1',
  seq,
  recordedAt: `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`,
});
const fail = (seq: number, second: number, reason: string): TurnEdge => ({
  type: 'turn_failed',
  agentSessionId: 7,
  harnessSessionId: 'h1',
  seq,
  recordedAt: `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`,
  reason,
});

test('a normal turn after the prompt is delivered as ended, with the turn to read the reply from', () => {
  const found = latestTurn(target, [start(1, 5), end(1, 6), start(2, 11), end(2, 20)]);
  assert.equal(found.kind, 'delivered');
  assert.ok(found.kind === 'delivered');
  assert.equal(found.event.outcome, 'ended');
  assert.deepEqual(found.turn, {
    harnessSessionId: 'h1',
    seq: 2,
    startedAt: '2026-01-01T00:00:11.000Z',
    completedAt: '2026-01-01T00:00:20.000Z',
  });
});

test('turns before the prompt never answer it, and a running latest turn keeps waiting', () => {
  assert.deepEqual(latestTurn(target, [start(1, 5), end(1, 6)]), {
    kind: 'waiting',
    started: false,
  });
  assert.deepEqual(latestTurn(target, [start(1, 11)]), { kind: 'waiting', started: true });
});

test('a new turn started mid-wait is followed instead of the one it superseded', () => {
  const found = latestTurn(target, [
    start(1, 11),
    start(2, 12),
    fail(1, 12, 'new_start_supersedes'),
  ]);
  assert.deepEqual(found, { kind: 'waiting', started: true });
  const done = latestTurn(target, [
    start(1, 11),
    start(2, 12),
    fail(1, 12, 'new_start_supersedes'),
    end(2, 30),
  ]);
  assert.ok(done.kind === 'delivered');
  assert.equal(done.event.outcome, 'ended');
});

test('a failed turn is delivered as failed, unless a newer turn has started since', () => {
  const failed = latestTurn(target, [start(1, 11), fail(1, 12, 'harness_error')]);
  assert.ok(failed.kind === 'delivered');
  assert.deepEqual(failed.event, {
    kind: 'agent_turn',
    outcome: 'failed',
    recordedAt: '2026-01-01T00:00:12.000Z',
    reason: 'harness_error',
  });
  const recovered = latestTurn(target, [
    start(1, 11),
    fail(1, 12, 'harness_error'),
    start(2, 40),
    end(2, 50),
  ]);
  assert.ok(recovered.kind === 'delivered');
  assert.equal(recovered.event.outcome, 'ended');
});

test('a session that died mid-turn is delivered as interrupted', () => {
  const died = latestTurn(target, [start(1, 11), fail(1, 12, 'session_died')]);
  assert.ok(died.kind === 'delivered');
  assert.deepEqual(died.event, {
    kind: 'agent_turn',
    outcome: 'interrupted',
    recordedAt: '2026-01-01T00:00:12.000Z',
    reason: 'session_died',
  });
});

test('another session never answers the wait', () => {
  const other: TurnEdge = { ...start(1, 11), agentSessionId: 8 };
  assert.deepEqual(latestTurn(target, [other]), { kind: 'waiting', started: false });
});
