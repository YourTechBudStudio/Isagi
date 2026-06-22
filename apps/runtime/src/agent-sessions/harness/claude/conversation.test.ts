import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import type { HarnessObservationRecord } from '../projection.js';
import { parseClaudeTranscript, readClaudeConversation } from './conversation.js';

test('Claude transcript parser skips tool-result user carriers and merges assistant text per turn', () => {
  const raw = [
    entry({
      uuid: 'user-1',
      type: 'user',
      promptSource: 'typed',
      message: { role: 'user', content: 'first prompt' },
    }),
    entry({
      uuid: 'assistant-1a',
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'first ' }] },
    }),
    entry({
      uuid: 'tool-result-1',
      type: 'user',
      promptSource: null,
      message: { role: 'user', content: [{ type: 'tool_result', content: 'tool noise' }] },
    }),
    entry({
      uuid: 'assistant-1b',
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hidden' },
          { type: 'text', text: 'answer' },
          { type: 'tool_use', name: 'Read' },
        ],
      },
    }),
    entry({
      uuid: 'user-2',
      type: 'user',
      promptSource: 'typed',
      message: { role: 'user', content: 'second prompt' },
    }),
  ].join('\n');

  assert.deepEqual(parseClaudeTranscript(raw), [
    { role: 'user', parts: [{ type: 'text', text: 'first prompt' }] },
    {
      role: 'assistant',
      parts: [
        { type: 'text', text: 'first ' },
        { type: 'text', text: 'answer' },
      ],
    },
    { role: 'user', parts: [{ type: 'text', text: 'second prompt' }] },
  ]);
});

test('Claude conversation reads transcript paths across streams and dedupes stable uuids', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-claude-transcript-'));
  try {
    const first = join(root, 'first.jsonl');
    const second = join(root, 'second.jsonl');
    writeFileSync(
      first,
      [
        entry({
          uuid: 'user-1',
          type: 'user',
          promptSource: 'typed',
          message: { role: 'user', content: 'first prompt' },
        }),
        entry({
          uuid: 'assistant-1',
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
        }),
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      second,
      [
        entry({
          uuid: 'user-1',
          type: 'user',
          promptSource: 'typed',
          message: { role: 'user', content: 'first prompt copy' },
        }),
        entry({
          uuid: 'user-2',
          type: 'user',
          promptSource: 'typed',
          message: { role: 'user', content: 'second prompt' },
        }),
        entry({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'kept without uuid' }] },
        }),
      ].join('\n'),
      'utf8',
    );

    const history = await Effect.runPromise(
      readClaudeConversation({
        agentSessionId: 10,
        streams: [
          ['claude-1', [stopRecord(0, first)]],
          ['claude-2', [stopRecord(1, second)]],
        ],
      }),
    );

    assert.deepEqual(history, [
      { role: 'user', parts: [{ type: 'text', text: 'first prompt' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'first answer' }] },
      { role: 'user', parts: [{ type: 'text', text: 'second prompt' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'kept without uuid' }] },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Claude conversation warns and returns empty for unreadable transcript paths', async () => {
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    const history = await Effect.runPromise(
      readClaudeConversation({
        agentSessionId: 10,
        streams: [['claude-1', [stopRecord(0, '/missing/transcript.jsonl')]]],
      }),
    );

    assert.deepEqual(history, []);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.[0], '[runtime] Claude transcript could not be read');
  } finally {
    console.warn = originalWarn;
  }
});

function stopRecord(seq: number, transcriptPath: string): HarnessObservationRecord {
  return {
    recordedAt: `2026-06-18T00:00:0${seq}.000Z`,
    seq,
    ptyProcessId: 20,
    harness: 'claude',
    nativeEvent: 'Stop',
    event: {
      nativeEvent: 'Stop',
      input: {
        hook_event_name: 'Stop',
        transcript_path: transcriptPath,
      },
    },
  };
}

function entry(value: Record<string, unknown>) {
  return JSON.stringify(value);
}
