import assert from 'node:assert/strict';
import test from 'node:test';

import type { HarnessObservationRecord } from '../projection.js';
import { reduceOpenCodeLifecycle } from './lifecycle.js';

test('OpenCode keeps retry and recoverable errors active until root idle', () => {
  const lifecycle = reduceOpenCodeLifecycle([
    record('session.status', 0, 'busy'),
    record('session.status', 1, 'retry'),
    { ...record('session.status', 2, 'busy'), nativeEvent: 'session.error' },
    record('session.status', 3, 'busy'),
    record('session.status', 4, 'idle'),
    record('session.status', 5, 'idle'),
  ]);
  assert.equal(lifecycle.attention, 'waiting');
  assert.deepEqual(
    lifecycle.diagnostics.map((diagnostic) => diagnostic.code),
    ['native_session_error'],
  );
  assert.deepEqual(lifecycle.terminalEdges, [
    { type: 'turn_ended', harnessSessionId: '', seq: 0, recordedAt: time(4) },
  ]);
});

test('OpenCode uses native event IDs when status callbacks append out of order', () => {
  const idleAppendedBeforeOlderBusy = reduceOpenCodeLifecycle([
    record('session.status', 0, 'busy', 0),
    record('session.status', 1, 'idle', 2),
    record('session.status', 2, 'busy', 1),
  ]);
  assert.equal(idleAppendedBeforeOlderBusy.activeTurn, null);
  assert.equal(idleAppendedBeforeOlderBusy.attention, 'waiting');
  assert.deepEqual(idleAppendedBeforeOlderBusy.terminalEdges, [
    { type: 'turn_ended', harnessSessionId: '', seq: 0, recordedAt: time(1) },
  ]);

  const nextBusyAppendedBeforeOlderIdle = reduceOpenCodeLifecycle([
    record('session.status', 0, 'busy', 0),
    record('session.status', 1, 'busy', 2),
    record('session.status', 2, 'idle', 1),
  ]);
  assert.equal(nextBusyAppendedBeforeOlderIdle.activeTurn?.seq, 1);
  assert.equal(nextBusyAppendedBeforeOlderIdle.attention, 'working');
  assert.deepEqual(nextBusyAppendedBeforeOlderIdle.terminalEdges, [
    { type: 'turn_ended', harnessSessionId: '', seq: 0, recordedAt: time(2) },
  ]);
});

test('OpenCode waits for native questions without closing the active turn', () => {
  const waiting = reduceOpenCodeLifecycle([
    record('session.status', 0, 'busy'),
    question('question.asked', 1, 'question-1'),
  ]);
  assert.equal(waiting.activeTurn?.seq, 0);
  assert.equal(waiting.attention, 'waiting');
  assert.deepEqual(waiting.terminalEdges, []);

  const replied = reduceOpenCodeLifecycle([
    record('session.status', 0, 'busy'),
    question('question.asked', 1, 'question-1'),
    question('question.replied', 2, 'question-1'),
  ]);
  assert.equal(replied.activeTurn?.seq, 0);
  assert.equal(replied.attention, 'working');

  const rejected = reduceOpenCodeLifecycle([
    record('session.status', 0, 'busy'),
    question('question.asked', 1, 'question-1'),
    question('question.rejected', 2, 'question-1'),
  ]);
  assert.equal(rejected.activeTurn?.seq, 0);
  assert.equal(rejected.attention, 'working');
});

test('OpenCode correlates multiple and out-of-order question callbacks by request ID', () => {
  const lifecycle = reduceOpenCodeLifecycle([
    record('session.status', 0, 'busy', 0),
    question('question.replied', 1, 'question-1', 3),
    question('question.asked', 2, 'question-2', 2),
    question('question.asked', 3, 'question-1', 1),
    question('question.replied', 4, 'question-1', 3),
  ]);
  assert.equal(lifecycle.activeTurn?.seq, 0);
  assert.equal(lifecycle.attention, 'waiting');
  assert.deepEqual(lifecycle.diagnostics, []);

  const completed = reduceOpenCodeLifecycle([
    record('session.status', 0, 'busy', 0),
    question('question.rejected', 1, 'question-2', 4),
    question('question.asked', 2, 'question-2', 2),
    question('question.asked', 3, 'question-1', 1),
    question('question.replied', 4, 'question-1', 3),
  ]);
  assert.equal(completed.attention, 'working');
});

test('OpenCode pending questions survive repeated busy/retry and clear at terminal idle', () => {
  const lifecycle = reduceOpenCodeLifecycle([
    record('session.status', 0, 'busy'),
    question('question.asked', 1, 'question-1'),
    record('session.status', 2, 'busy'),
    record('session.status', 3, 'retry'),
  ]);
  assert.equal(lifecycle.attention, 'waiting');

  const ended = reduceOpenCodeLifecycle([
    record('session.status', 0, 'busy'),
    question('question.asked', 1, 'question-1'),
    record('session.status', 2, 'idle'),
    question('question.replied', 3, 'question-1'),
  ]);
  assert.equal(ended.activeTurn, null);
  assert.equal(ended.attention, 'waiting');
  assert.equal(ended.terminalEdges[0]?.type, 'turn_ended');
});

test('OpenCode ignores duplicate delivery and diagnoses unusable native evidence', () => {
  const duplicateAsked = question('question.asked', 1, 'question-1');
  const duplicateReplied = question('question.replied', 2, 'question-1');
  const lifecycle = reduceOpenCodeLifecycle([
    record('session.status', 0, 'busy'),
    duplicateAsked,
    { ...duplicateAsked, seq: 2, recordedAt: time(2) },
    duplicateReplied,
    { ...duplicateReplied, seq: 3, recordedAt: time(3) },
    question('question.replied', 4, 'unknown-question'),
    {
      ...record('session.status', 5, 'idle'),
      event: { type: 'session.status', properties: { sessionID: 'root', status: 'idle' } },
    },
  ]);
  assert.equal(lifecycle.activeTurn?.seq, 0);
  assert.equal(lifecycle.attention, 'working');
  assert.deepEqual(lifecycle.diagnostics.map((diagnostic) => diagnostic.code).sort(), [
    'missing_native_event_id',
    'unmatched_user_input_completion',
  ]);
});

test('OpenCode keeps state conservative when question correlation fields are malformed', () => {
  const lifecycle = reduceOpenCodeLifecycle([
    record('session.status', 0, 'busy'),
    {
      ...question('question.asked', 1, 'unused'),
      event: {
        id: eventId(1),
        type: 'question.asked',
        properties: { sessionID: 'root', questions: [] },
      },
    },
    {
      ...question('question.replied', 2, 'unused'),
      event: {
        id: eventId(2),
        type: 'question.replied',
        properties: { sessionID: 'root', answers: [] },
      },
    },
  ]);
  assert.equal(lifecycle.activeTurn?.seq, 0);
  assert.equal(lifecycle.attention, 'working');
  assert.deepEqual(
    lifecycle.diagnostics.map((diagnostic) => diagnostic.code),
    ['malformed_optional_field', 'malformed_optional_field'],
  );
});

test('OpenCode diagnoses unknown native status shapes', () => {
  const lifecycle = reduceOpenCodeLifecycle([record('session.status', 0, { unexpected: true })]);
  assert.equal(lifecycle.activeTurn, null);
  assert.equal(lifecycle.diagnostics[0]?.code, 'unknown_status_shape');
});

function record(
  nativeEvent: string,
  seq: number,
  status: unknown,
  nativeOrder = seq,
): HarnessObservationRecord {
  return {
    recordedAt: time(seq),
    seq,
    ptyProcessId: 20,
    harness: 'opencode',
    nativeEvent,
    event: {
      id: eventId(nativeOrder),
      type: nativeEvent,
      properties: { sessionID: 'root', status },
    },
  };
}

function question(nativeEvent: string, seq: number, requestId: string, nativeOrder = seq) {
  return {
    recordedAt: time(seq),
    seq,
    ptyProcessId: 20,
    harness: 'opencode' as const,
    nativeEvent,
    event: {
      id: eventId(nativeOrder),
      type: nativeEvent,
      properties:
        nativeEvent === 'question.asked'
          ? { id: requestId, sessionID: 'root', questions: [] }
          : { requestID: requestId, sessionID: 'root' },
    },
  };
}

function eventId(order: number) {
  return `evt_${order.toString(16).padStart(12, '0')}fixture`;
}

function time(index: number) {
  return `2026-07-09T00:00:0${index}.000Z`;
}
