import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defaultHeadlessTimeoutMs,
  extractHeadlessOutput,
  normalizeHeadlessLaunch,
  semanticErrorForHeadlessOutput,
} from './headless.js';

test('normalizeHeadlessLaunch resolves timeout before persistence', () => {
  assert.deepEqual(
    normalizeHeadlessLaunch({ harness: 'claude', prompt: 'judge', model: 'sonnet' }),
    {
      harness: 'claude',
      prompt: 'judge',
      model: 'sonnet',
      effort: undefined,
      timeoutMs: defaultHeadlessTimeoutMs,
    },
  );
  assert.equal(
    normalizeHeadlessLaunch({ harness: 'claude', prompt: 'judge', timeoutMs: 30_000 }).timeoutMs,
    30_000,
  );
});

test('extractHeadlessOutput reads Claude final result JSON', () => {
  assert.equal(
    extractHeadlessOutput(
      'claude',
      JSON.stringify([
        { type: 'assistant', message: 'ignored' },
        { type: 'result', result: 'ok' },
      ]),
    ),
    'ok',
  );
});

test('extractHeadlessOutput reads Claude result before PTY teardown bytes', () => {
  assert.equal(
    extractHeadlessOutput(
      'claude',
      `${JSON.stringify([{ type: 'result', result: 'ok' }])}\r\n\u001b[?25h\u000f`,
    ),
    'ok',
  );
});

test('extractHeadlessOutput reconstructs Pi assistant text from JSON events', () => {
  assert.equal(
    extractHeadlessOutput(
      'pi',
      [
        JSON.stringify({ nativeEvent: 'agent_start' }),
        JSON.stringify({
          nativeEvent: 'agent_end',
          messages: [
            { role: 'user', content: 'question' },
            { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
          ],
        }),
      ].join('\n'),
    ),
    'answer',
  );
});

test('semanticErrorForHeadlessOutput detects Pi stop reasons from raw events', () => {
  assert.equal(
    semanticErrorForHeadlessOutput(
      'pi',
      [
        JSON.stringify({
          nativeEvent: 'agent_end',
          message: {
            stopReason: 'error',
          },
        }),
      ].join('\n'),
    ),
    'error',
  );
});

test('extractHeadlessOutput line-filters OpenCode mixed stdout JSON', () => {
  assert.equal(
    extractHeadlessOutput(
      'opencode',
      [
        'database is locked',
        JSON.stringify({
          event: {
            properties: {
              part: {
                messageID: 'assistant-1',
                type: 'text',
                text: 'first ',
              },
            },
          },
        }),
        JSON.stringify({
          event: {
            properties: {
              info: {
                id: 'assistant-1',
                role: 'assistant',
              },
            },
          },
        }),
      ].join('\n'),
    ),
    'first',
  );
});

test('extractHeadlessOutput falls back to trimmed Codex text when no JSON final is present', () => {
  assert.equal(extractHeadlessOutput('codex', '\u001b[32mplain answer\u001b[0m\n'), 'plain answer');
});
