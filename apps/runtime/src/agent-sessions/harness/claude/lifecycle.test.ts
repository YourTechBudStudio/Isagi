import assert from 'node:assert/strict';
import test from 'node:test';

import type { HarnessObservationRecord } from '../projection.js';
import { reduceClaudeLifecycle } from './lifecycle.js';

test('Claude keeps non-empty background work active and ends on the next empty Stop', () => {
  const background = reduceClaudeLifecycle([
    record('UserPromptSubmit', 0),
    record('Stop', 1, { background_tasks: [{ task_id: 'redacted-task' }] }),
  ]);
  assert.equal(background.activeTurn?.seq, 0);
  assert.equal(background.attention, 'working');
  assert.deepEqual(background.terminalEdges, []);

  const lifecycle = reduceClaudeLifecycle([
    record('UserPromptSubmit', 0),
    record('Stop', 1, { background_tasks: [{ task_id: 'redacted-task' }] }),
    record('UserPromptSubmit', 2, { prompt: '<task-notification>redacted</task-notification>' }),
    record('Stop', 3, { background_tasks: [] }),
  ]);
  assert.equal(lifecycle.activeTurn, null);
  assert.equal(lifecycle.attention, 'waiting');
  assert.deepEqual(lifecycle.terminalEdges, [
    { type: 'turn_ended', harnessSessionId: '', seq: 0, recordedAt: time(3) },
  ]);
});

test('Claude keeps multiple background-result continuations in the opening logical turn', () => {
  const lifecycle = reduceClaudeLifecycle([
    record('UserPromptSubmit', 0),
    record('Stop', 1, { background_tasks: [{ task_id: 'task-a' }, { task_id: 'task-b' }] }),
    record('UserPromptSubmit', 2, { prompt: '<task-notification>task-a</task-notification>' }),
    record('Stop', 3, { background_tasks: [{ task_id: 'task-b' }] }),
    record('UserPromptSubmit', 4, { prompt: '<task-notification>task-b</task-notification>' }),
  ]);
  assert.equal(lifecycle.activeTurn?.seq, 0);
  assert.equal(lifecycle.attention, 'working');
  assert.deepEqual(lifecycle.terminalEdges, []);
});

test('Claude waits during AskUserQuestion and resumes working after answer or cancellation', () => {
  const waiting = reduceClaudeLifecycle([
    record('UserPromptSubmit', 0),
    question('PreToolUse', 1, 'question-1'),
  ]);
  assert.equal(waiting.activeTurn?.seq, 0);
  assert.equal(waiting.attention, 'waiting');
  assert.deepEqual(waiting.terminalEdges, []);

  const answered = reduceClaudeLifecycle([
    record('UserPromptSubmit', 0),
    question('PreToolUse', 1, 'question-1'),
    question('PostToolUse', 2, 'question-1'),
  ]);
  assert.equal(answered.activeTurn?.seq, 0);
  assert.equal(answered.attention, 'working');

  const cancelled = reduceClaudeLifecycle([
    record('UserPromptSubmit', 0),
    question('PreToolUse', 1, 'question-1'),
    question('PostToolUseFailure', 2, 'question-1'),
  ]);
  assert.equal(cancelled.activeTurn?.seq, 0);
  assert.equal(cancelled.attention, 'working');
});

test('Claude correlates multiple questions and ignores duplicate native hook delivery', () => {
  const onePending = reduceClaudeLifecycle([
    record('UserPromptSubmit', 0),
    question('PreToolUse', 1, 'question-1'),
    question('PreToolUse', 2, 'question-1'),
    question('PreToolUse', 3, 'question-2'),
    question('PostToolUse', 4, 'question-1'),
    question('PostToolUse', 5, 'question-1'),
  ]);
  assert.equal(onePending.attention, 'waiting');
  assert.deepEqual(onePending.diagnostics, []);

  const allAnswered = reduceClaudeLifecycle([
    record('UserPromptSubmit', 0),
    question('PreToolUse', 1, 'question-1'),
    question('PreToolUse', 2, 'question-2'),
    question('PostToolUse', 3, 'question-1'),
    question('PostToolUseFailure', 4, 'question-2'),
  ]);
  assert.equal(allAnswered.attention, 'working');
});

test('Claude degrades malformed and unmatched question completion without fabricating attention', () => {
  const lifecycle = reduceClaudeLifecycle([
    record('UserPromptSubmit', 0),
    record('PreToolUse', 1, { tool_name: 'AskUserQuestion' }),
    question('PostToolUse', 2, 'question-without-start'),
    question('PreToolUse', 3, 'question-without-start'),
    record('PreToolUse', 4, { tool_name: 'Bash', tool_use_id: 'bash-1' }),
  ]);
  assert.equal(lifecycle.attention, 'working');
  assert.deepEqual(
    lifecycle.diagnostics.map((diagnostic) => diagnostic.code),
    ['malformed_optional_field', 'unmatched_user_input_completion'],
  );
});

test('Claude preserves question correlation across continuation prompts and clears it on terminal evidence', () => {
  const continued = reduceClaudeLifecycle([
    record('UserPromptSubmit', 0),
    question('PreToolUse', 1, 'question-1'),
    record('UserPromptSubmit', 2, { prompt: '<task-notification>result</task-notification>' }),
    question('PostToolUse', 3, 'question-1'),
  ]);
  assert.equal(continued.activeTurn?.seq, 0);
  assert.equal(continued.attention, 'working');
  assert.deepEqual(continued.terminalEdges, []);

  const stillWaiting = reduceClaudeLifecycle([
    record('UserPromptSubmit', 0),
    question('PreToolUse', 1, 'question-1'),
    record('UserPromptSubmit', 2, { prompt: '<task-notification>result</task-notification>' }),
  ]);
  assert.equal(stillWaiting.activeTurn?.seq, 0);
  assert.equal(stillWaiting.attention, 'waiting');

  const ended = reduceClaudeLifecycle([
    record('UserPromptSubmit', 0),
    question('PreToolUse', 1, 'question-1'),
    record('Stop', 2, { background_tasks: [] }),
    question('PostToolUse', 3, 'question-1'),
  ]);
  assert.equal(ended.activeTurn, null);
  assert.equal(ended.attention, 'waiting');
  assert.equal(ended.terminalEdges[0]?.type, 'turn_ended');

  const failed = reduceClaudeLifecycle([
    record('UserPromptSubmit', 0),
    question('PreToolUse', 1, 'question-1'),
    record('StopFailure', 2),
  ]);
  assert.equal(failed.activeTurn, null);
  assert.equal(failed.attention, 'error');
  assert.equal(failed.terminalEdges[0]?.type, 'turn_failed');
});

test('Claude new prompt retires an interrupted question and ignores late hooks from that prompt', () => {
  // Redacted Graph Workflows sequence: AskUserQuestion had no completion hook
  // before another user prompt arrived.
  const records = [
    record('UserPromptSubmit', 0, { prompt_id: 'old' }),
    record('PreToolUse', 1, {
      prompt_id: 'old',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'question-1',
    }),
    record('UserPromptSubmit', 2, { prompt_id: 'new' }),
  ];
  const resumed = reduceClaudeLifecycle(records);
  assert.equal(resumed.attention, 'working');
  assert.equal(resumed.activeTurn?.seq, 2);
  assert.deepEqual(resumed.terminalEdges, [
    {
      type: 'turn_failed',
      harnessSessionId: '',
      seq: 0,
      recordedAt: time(2),
      reason: 'new_start_supersedes',
    },
  ]);

  const late = reduceClaudeLifecycle([
    ...records,
    record('UserPromptSubmit', 3, { prompt_id: 'old' }),
    record('PreToolUse', 4, {
      prompt_id: 'old',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'question-2',
    }),
    record('Stop', 5, { prompt_id: 'old', background_tasks: [] }),
    record('StopFailure', 6, { prompt_id: 'old' }),
  ]);
  assert.deepEqual(late, resumed);
  const ended = reduceClaudeLifecycle([
    ...records,
    record('Stop', 3, { prompt_id: 'new', background_tasks: [] }),
    record('UserPromptSubmit', 4, { prompt_id: 'new' }),
  ]);
  assert.equal(ended.attention, 'waiting');
  assert.equal(ended.activeTurn, null);
  assert.equal(ended.terminalEdges.at(-1)?.seq, 2);
});

test('Claude identified background continuation preserves the turn and its pending question', () => {
  const records = [
    record('UserPromptSubmit', 0, { prompt_id: 'user' }),
    record('PreToolUse', 1, {
      prompt_id: 'user',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'question-1',
    }),
    record('UserPromptSubmit', 2, {
      prompt_id: 'background',
      prompt: '<task-notification>redacted</task-notification>',
    }),
  ];
  const continued = reduceClaudeLifecycle(records);
  assert.equal(continued.activeTurn?.seq, 0);
  assert.equal(continued.attention, 'waiting');
  assert.deepEqual(continued.terminalEdges, []);
  const answered = reduceClaudeLifecycle([
    ...records,
    record('PostToolUse', 3, {
      prompt_id: 'user',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'question-1',
    }),
    record('Stop', 4, { prompt_id: 'background', background_tasks: [] }),
  ]);
  assert.equal(answered.activeTurn, null);
  assert.equal(answered.terminalEdges[0]?.seq, 0);
});

test('Claude same-process interruption retires the question without prompt IDs', () => {
  const lifecycle = reduceClaudeLifecycle([
    record('UserPromptSubmit', 0, { prompt: 'First request' }),
    question('PreToolUse', 1, 'old-question'),
    record('UserPromptSubmit', 2, { prompt: 'Do this instead' }),
  ]);
  assert.equal(lifecycle.attention, 'working');
  assert.equal(lifecycle.activeTurn?.seq, 2);
  assert.deepEqual(lifecycle.terminalEdges, [
    {
      type: 'turn_failed',
      harnessSessionId: '',
      seq: 0,
      recordedAt: time(2),
      reason: 'new_start_supersedes',
    },
  ]);
});

test('Claude replacement process opens its own turn even without prompt IDs', () => {
  const lifecycle = reduceClaudeLifecycle([
    record('UserPromptSubmit', 0),
    question('PreToolUse', 1, 'old-question'),
    { ...record('UserPromptSubmit', 2), ptyProcessId: 21 },
  ]);
  assert.equal(lifecycle.attention, 'working');
  assert.equal(lifecycle.activeTurn?.ptyProcessId, 21);
  assert.equal(lifecycle.activeTurn?.seq, 2);
  assert.deepEqual(lifecycle.terminalEdges, [
    {
      type: 'turn_failed',
      harnessSessionId: '',
      seq: 0,
      recordedAt: time(0),
      reason: 'session_died',
    },
  ]);
});

test('Claude Stop ignores passive monitors but retains genuine or unknown background work', () => {
  const monitor = { id: 'monitor-1', type: 'monitor', status: 'running' };
  const ended = reduceClaudeLifecycle([
    record('UserPromptSubmit', 0),
    record('Stop', 1, { background_tasks: [monitor] }),
  ]);
  assert.equal(ended.attention, 'waiting');
  assert.equal(ended.activeTurn, null);
  assert.equal(ended.terminalEdges[0]?.type, 'turn_ended');
  for (const task of [{ type: 'subagent' }, { type: 'shell' }, { type: 'future-type' }, {}]) {
    const working = reduceClaudeLifecycle([
      record('UserPromptSubmit', 0),
      record('Stop', 1, { background_tasks: [monitor, task] }),
    ]);
    assert.equal(working.attention, 'working');
    assert.equal(working.activeTurn?.seq, 0);
  }
});

test('Claude tolerates malformed optional fields without changing raw event routing', () => {
  const lifecycle = reduceClaudeLifecycle([
    record('UserPromptSubmit', 0),
    record('Stop', 1, { background_tasks: 'not-an-array', stop_hook_active: 'not-a-boolean' }),
    record('StopFailure', 2, { error_details: { arbitrary: true } }),
  ]);
  assert.equal(lifecycle.diagnostics[0]?.code, 'malformed_optional_field');
  assert.deepEqual(lifecycle.terminalEdges[0], {
    type: 'turn_failed',
    harnessSessionId: '',
    seq: 0,
    recordedAt: time(2),
    reason: 'harness_error',
  });
});

test('Claude malformed Stop stays active until later native terminal evidence', () => {
  const lifecycle = reduceClaudeLifecycle([
    record('UserPromptSubmit', 0),
    record('Stop', 1, { background_tasks: 'unknown' }),
    record('Stop', 2, { background_tasks: [] }),
  ]);
  assert.equal(lifecycle.attention, 'waiting');
  assert.equal(lifecycle.terminalEdges[0]?.type, 'turn_ended');
  assert.equal(lifecycle.terminalEdges[0]?.recordedAt, time(2));
  assert.deepEqual(
    lifecycle.diagnostics.map((diagnostic) => diagnostic.code),
    ['malformed_optional_field'],
  );
});

test('Claude duplicate empty Stop and legacy Notification evidence commit one terminal', () => {
  const lifecycle = reduceClaudeLifecycle([
    record('UserPromptSubmit', 0),
    record('Stop', 1, { background_tasks: [] }),
    record('Stop', 2, { background_tasks: [] }),
    record('Notification', 3, { notification_type: 'idle_prompt' }),
  ]);
  assert.deepEqual(lifecycle.terminalEdges, [
    { type: 'turn_ended', harnessSessionId: '', seq: 0, recordedAt: time(1) },
  ]);
});

function record(
  nativeEvent: string,
  seq: number,
  event: Record<string, unknown> = {},
): HarnessObservationRecord {
  return { recordedAt: time(seq), seq, ptyProcessId: 20, harness: 'claude', nativeEvent, event };
}

function question(nativeEvent: string, seq: number, toolUseId: string) {
  return record(nativeEvent, seq, {
    tool_name: 'AskUserQuestion',
    tool_use_id: toolUseId,
  });
}

function time(index: number) {
  return `2026-07-09T00:00:0${index}.000Z`;
}
