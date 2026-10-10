import assert from 'node:assert/strict';
import test from 'node:test';

import { reduceCodexRolloutLifecycle, type CodexRolloutLifecycleRecord } from './lifecycle.js';
import { parseCodexRolloutEntries } from './native-artifacts.js';

test('Codex correlates multiple rollout turns by native turn_id and preserves abort failure', () => {
  const entries = parseCodexRolloutEntries(`
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-redacted-1"}}
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-redacted-1"}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-redacted-2"}}
{"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"turn-redacted-2","reason":"interrupted"}}
{"type":"event_msg","payload":{"type":"future_event","turn_id":"turn-redacted-3"}}
not json
`);
  const lifecycle = reduceCodexRolloutLifecycle(entries.map(record));
  assert.deepEqual(lifecycle.terminalEdges, [
    { type: 'turn_ended', harnessSessionId: '', seq: 0, recordedAt: time(1) },
    {
      type: 'turn_failed',
      harnessSessionId: '',
      seq: 2,
      recordedAt: time(3),
      reason: 'harness_error',
    },
  ]);
  assert.equal(lifecycle.attention, 'error');
  assert.equal(lifecycle.diagnostics[0]?.code, 'native_turn_aborted');
});

test('Codex degrades unsupported lifecycle shapes instead of inventing a terminal edge', () => {
  const lifecycle = reduceCodexRolloutLifecycle([
    record({ type: 'event_msg', payload: { type: 'task_started' } }),
    record({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'unknown' } }),
  ]);
  assert.equal(lifecycle.terminalEdges.length, 0);
  assert.deepEqual(
    lifecycle.diagnostics.map((diagnostic) => diagnostic.code),
    ['missing_native_turn_id', 'unknown_native_turn'],
  );
});

test('Codex ignores duplicate starts and diagnoses duplicate terminals without inventing turns', () => {
  sequence = 0;
  const lifecycle = reduceCodexRolloutLifecycle([
    record({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } }),
    record({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } }),
    record({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } }),
    record({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } }),
  ]);
  assert.equal(lifecycle.terminalEdges.length, 1);
  assert.equal(lifecycle.diagnostics.at(-1)?.code, 'unknown_native_turn');
});

let sequence = 0;
function record(entry: Record<string, unknown>): CodexRolloutLifecycleRecord {
  const seq = sequence++;
  return { seq, recordedAt: time(seq), ptyProcessId: 20, entry };
}

function time(index: number) {
  return `2026-07-09T00:00:0${index}.000Z`;
}
