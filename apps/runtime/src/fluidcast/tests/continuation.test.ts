import assert from 'node:assert/strict';
import test from 'node:test';

import type { TranscriptEntry } from '@yourtechbudstudio/fluidcast-tool-agent';

import { continueCallLabel, continueMessage, continueStart, lastAnswer } from '../continuation.js';

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
  assert.equal(continueCallLabel, 'Your last answer in this session');
});

test('the continuation start replays the last answer as an answered forward_agent call', () => {
  assert.deepEqual(continueStart('The answer.'), {
    message: continueMessage,
    call: {
      label: continueCallLabel,
      tool: 'forward_agent',
      input: {},
      result: { messages: ['The answer.'] },
    },
  });
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

test('the last answer leaves out the worker thinking between the prompt and the answer', () => {
  const entries: ReadonlyArray<TranscriptEntry> = [
    prompt('the question'),
    { _tag: 'thinking', summary: 'Weighing the options', parentToolUseId: null },
    text('the answer'),
  ];
  assert.equal(lastAnswer(entries), 'the answer');
});

test('there is no last answer without top-level text after the last prompt', () => {
  assert.equal(lastAnswer([]), undefined);
  assert.equal(lastAnswer([text('an answer'), prompt('unanswered')]), undefined);
  assert.equal(lastAnswer([prompt('q'), text('nested', 't1')]), undefined);
  // Text with no prompt at all (a transcript that starts mid-conversation) still counts.
  assert.equal(lastAnswer([text('orphan')]), 'orphan');
});
