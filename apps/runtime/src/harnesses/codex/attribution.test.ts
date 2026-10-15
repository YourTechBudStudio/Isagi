import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExecutionInterval, Incarnation } from '../incarnation.js';
import { attributeCodexRecords, type SessionStartBoundary } from './attribution.js';
import type { CodexRolloutRecord } from './lifecycle.js';

test('two boundaries: a record keeps the execution it was written under, whenever it is read', () => {
  const intervals = [interval('pty:1', 0), interval('sdk:a', 10)];
  const sessionStarts = [boundary('pty:1', 1), boundary('sdk:a', 11)];
  assert.deepEqual(attributed([5, 12], sessionStarts, intervals), ['pty:1', 'sdk:a']);
});

test('SDK hook missing: SDK records after the switch stay unattributed', () => {
  const intervals = [interval('pty:1', 0), interval('sdk:a', 10)];
  assert.deepEqual(attributed([5, 12], [boundary('pty:1', 1)], intervals), ['pty:1', null]);
});

test('a late predecessor write after the switch is unattributed, not the predecessor', () => {
  const intervals = [interval('pty:1', 0), interval('sdk:a', 10)];
  const sessionStarts = [boundary('pty:1', 1), boundary('sdk:a', 11)];
  assert.deepEqual(attributed([10.5], sessionStarts, intervals), [null]);
});

test('an entry before any boundary of its interval is unattributed', () => {
  assert.deepEqual(attributed([2, 6], [boundary('pty:1', 5)], [interval('pty:1', 0)]), [
    null,
    'pty:1',
  ]);
});

test('PTY → SDK with a missing hook → PTY: the SDK records stay unattributed for good', () => {
  const sessionStarts = [boundary('pty:1', 1), boundary('pty:2', 21)];
  const whileSdkRuns = attributed([12], sessionStarts, [
    interval('pty:1', 0),
    interval('sdk:a', 10),
  ]);
  const afterReturn = attributed([12, 22], sessionStarts, [
    interval('pty:1', 0),
    interval('sdk:a', 10),
    interval('pty:2', 20),
  ]);
  assert.deepEqual(whileSdkRuns, [null]);
  assert.deepEqual(afterReturn, [null, 'pty:2']);
});

test('quick double switch: the short middle interval still attributes its own records', () => {
  const intervals = [interval('pty:1', 0), interval('sdk:a', 10), interval('pty:2', 11)];
  const sessionStarts = [boundary('pty:1', 1), boundary('sdk:a', 10.2), boundary('pty:2', 12)];
  assert.deepEqual(attributed([10.5, 11.5, 12.5], sessionStarts, intervals), [
    'sdk:a',
    null,
    'pty:2',
  ]);
});

test('pre-restart history falls back to the preceding SessionStart, an execution that ended', () => {
  const sessionStarts = [boundary('pty:1', 1), boundary('pty:2', 101)];
  assert.deepEqual(attributed([0.5, 50, 102], sessionStarts, [interval('pty:2', 100)]), [
    null,
    'pty:1',
    'pty:2',
  ]);
});

test('an agent with no known interval attributes everything by the preceding SessionStart', () => {
  assert.deepEqual(attributed([0.5, 5], [boundary('pty:1', 1)], []), [null, 'pty:1']);
});

test('a record without a usable timestamp, or in a no-execution interval, is unattributed', () => {
  const intervals = [interval('pty:1', 0), interval(null, 10)];
  const records: CodexRolloutRecord[] = [
    { seq: 0, recordedAt: '', entry: { type: 'event_msg', payload: {} } },
    { seq: 1, recordedAt: 'not a time', entry: { type: 'event_msg', payload: {} } },
    { seq: 2, recordedAt: at(12), entry: { type: 'event_msg', payload: {} } },
  ];
  const result = attributeCodexRecords({
    records,
    sessionStarts: [boundary('pty:1', 1)],
    intervals,
  });
  assert.deepEqual(
    result.map((record) => record.incarnation),
    [null, null, null],
  );
});

function attributed(
  times: readonly number[],
  sessionStarts: readonly SessionStartBoundary[],
  intervals: readonly ExecutionInterval[],
) {
  const records = times.map((time, seq) => ({
    seq,
    recordedAt: at(time),
    entry: { type: 'event_msg', payload: {} },
  }));
  return attributeCodexRecords({ records, sessionStarts, intervals }).map(
    (record) => record.incarnation,
  );
}

function interval(incarnation: Incarnation | null, seconds: number): ExecutionInterval {
  return { incarnation, since: at(seconds) };
}

function boundary(incarnation: Incarnation | null, seconds: number): SessionStartBoundary {
  return { incarnation, recordedAt: at(seconds) };
}

function at(seconds: number) {
  return new Date(Date.UTC(2026, 6, 9) + seconds * 1000).toISOString();
}
