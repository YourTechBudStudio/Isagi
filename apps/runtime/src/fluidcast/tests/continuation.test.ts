import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReminderEvent } from '@yourtechbudstudio/fluidcast-core/generation';
import type { TranscriptEntry } from '@yourtechbudstudio/fluidcast-tool-agent';

import {
  continueContextLabel,
  continueMessage,
  continueReminder,
  continueReminders,
  lastAnswer,
} from '../continuation.js';

const prompt = (text: string, parentToolUseId: string | null = null): TranscriptEntry => ({
  _tag: 'prompt',
  source: 'earlier',
  text,
  parentToolUseId,
});
const text = (value: string, parentToolUseId: string | null = null): TranscriptEntry => ({
  _tag: 'text',
  text: value,
  parentToolUseId,
});

test('the continuation strings equal the reference backend verbatim', () => {
  // Pinned copies of Fluidcast's `apps/backend/src/conversation/modes.ts`: the story requires them reproduced.
  assert.equal(continueMessage, 'Walk me through your last answer.');
  assert.equal(continueContextLabel, 'Your last answer in this session');
  assert.equal(
    continueReminder,
    'The <context> above is your own last answer in this session; treat it as a `forward_agent` result. Present only the first segment of this result now, then stop with an `ask`.',
  );
});

test('the last answer is the top-level text after the last top-level prompt', () => {
  const entries: TranscriptEntry[] = [
    prompt('first question'),
    text('old answer'),
    prompt('second question'),
    text('part one'),
    {
      _tag: 'toolCall',
      toolUseId: 't1',
      name: 'Read',
      input: '{}',
      truncated: false,
      parentToolUseId: null,
    },
    prompt('a subagent prompt', 't1'),
    text('a subagent reply', 't1'),
    {
      _tag: 'toolResult',
      toolUseId: 't1',
      content: 'ok',
      truncated: false,
      isError: false,
      parentToolUseId: null,
    },
    text('part two'),
    { _tag: 'turnEnd', outcome: 'success', parentToolUseId: null },
  ];
  assert.equal(lastAnswer(entries), 'part one\n\npart two');
});

test('there is no last answer without top-level text after the last prompt', () => {
  assert.equal(lastAnswer([]), undefined);
  assert.equal(lastAnswer([text('an answer'), prompt('unanswered')]), undefined);
  assert.equal(lastAnswer([prompt('q'), text('nested', 't1')]), undefined);
  // Text with no prompt at all (a transcript that starts mid-conversation) still counts.
  assert.equal(lastAnswer([text('orphan')]), 'orphan');
});

test('the continue reminder applies only to a message read with context', () => {
  const reminders = continueReminders(() => 'preset');
  const message = (context: ReadonlyArray<string>): ReminderEvent => ({
    _tag: 'UserMessage',
    text: continueMessage,
    interrupted: false,
    context,
  });
  const withContext = message([continueContextLabel]);
  const plain = message([]);
  assert.equal(reminders(withContext), continueReminder);
  assert.equal(reminders(plain), 'preset');
});
