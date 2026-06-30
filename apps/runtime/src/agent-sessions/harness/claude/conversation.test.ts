import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import type { HarnessObservationRecord } from '../projection.js';
import {
  nativeClaudeTranscriptPath,
  parseClaudeTranscript,
  readClaudeConversation,
} from './conversation.js';

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

test('Claude transcript parser follows the active leaf parent chain', () => {
  const raw = [
    entry({
      uuid: 'system-1',
      type: 'system',
      parentUuid: null,
      content: 'system noise',
    }),
    entry({
      uuid: 'user-1',
      parentUuid: 'system-1',
      type: 'user',
      promptSource: 'typed',
      message: { role: 'user', content: 'first prompt' },
    }),
    entry({
      uuid: 'assistant-1',
      parentUuid: 'user-1',
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
    }),
    entry({
      uuid: 'inactive-user',
      parentUuid: 'assistant-1',
      type: 'user',
      promptSource: 'typed',
      message: { role: 'user', content: 'inactive prompt' },
    }),
    entry({
      uuid: 'inactive-assistant',
      parentUuid: 'inactive-user',
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'inactive answer' }] },
    }),
    entry({
      uuid: 'active-user',
      parentUuid: 'assistant-1',
      type: 'user',
      promptSource: 'typed',
      message: { role: 'user', content: 'active prompt' },
    }),
    entry({
      uuid: 'active-assistant',
      parentUuid: 'active-user',
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'active answer' }] },
    }),
    entry({
      type: 'last-prompt',
      leafUuid: 'active-assistant',
      sessionId: 'claude-session-1',
    }),
  ].join('\n');

  assert.deepEqual(parseClaudeTranscript(raw), [
    { role: 'user', parts: [{ type: 'text', text: 'first prompt' }] },
    { role: 'assistant', parts: [{ type: 'text', text: 'first answer' }] },
    { role: 'user', parts: [{ type: 'text', text: 'active prompt' }] },
    { role: 'assistant', parts: [{ type: 'text', text: 'active answer' }] },
  ]);
});

test('Claude transcript parser follows a typed branch appended after a stale last-prompt marker', () => {
  const raw = [
    entry({
      uuid: 'root',
      type: 'system',
      parentUuid: null,
    }),
    entry({
      uuid: 'first-user',
      parentUuid: 'root',
      type: 'user',
      promptSource: 'typed',
      message: { role: 'user', content: 'first prompt' },
    }),
    entry({
      uuid: 'first-assistant',
      parentUuid: 'first-user',
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
    }),
    entry({
      uuid: 'old-user',
      parentUuid: 'first-assistant',
      type: 'user',
      promptSource: 'typed',
      message: { role: 'user', content: 'old prompt' },
    }),
    entry({
      uuid: 'old-assistant',
      parentUuid: 'old-user',
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] },
    }),
    entry({
      type: 'last-prompt',
      leafUuid: 'old-assistant',
      sessionId: 'claude-session-1',
    }),
    entry({
      type: 'file-history-snapshot',
      messageId: 'new-user',
    }),
    entry({
      uuid: 'new-user',
      parentUuid: 'first-assistant',
      type: 'user',
      promptSource: 'typed',
      message: { role: 'user', content: 'new prompt' },
    }),
    entry({
      uuid: 'new-assistant',
      parentUuid: 'new-user',
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'new answer' }] },
    }),
    entry({
      uuid: 'new-turn-duration',
      parentUuid: 'new-assistant',
      type: 'system',
      subtype: 'turn_duration',
    }),
  ].join('\n');

  assert.deepEqual(parseClaudeTranscript(raw), [
    { role: 'user', parts: [{ type: 'text', text: 'first prompt' }] },
    { role: 'assistant', parts: [{ type: 'text', text: 'first answer' }] },
    { role: 'user', parts: [{ type: 'text', text: 'new prompt' }] },
    { role: 'assistant', parts: [{ type: 'text', text: 'new answer' }] },
  ]);
});

test('Claude transcript parser falls back to linear parsing when the active leaf is unavailable', () => {
  const raw = [
    entry({
      uuid: 'user-1',
      type: 'user',
      promptSource: 'typed',
      message: { role: 'user', content: 'first prompt' },
    }),
    entry({
      uuid: 'assistant-1',
      parentUuid: 'user-1',
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
    }),
    entry({
      type: 'last-prompt',
      leafUuid: 'missing-leaf',
      sessionId: 'claude-session-1',
    }),
  ].join('\n');

  assert.deepEqual(parseClaudeTranscript(raw), [
    { role: 'user', parts: [{ type: 'text', text: 'first prompt' }] },
    { role: 'assistant', parts: [{ type: 'text', text: 'first answer' }] },
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

test('Claude conversation prefers native session transcript over stale hook transcript paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-claude-native-transcript-'));
  try {
    const claudeDirectory = join(root, '.claude');
    const native = nativeClaudeTranscriptPath({
      claudeDirectory,
      cwd: '/repo/isagi',
      harnessSessionId: 'claude-session-1',
    });
    const stale = join(root, 'stale.jsonl');
    mkdirSync(dirname(native), { recursive: true });
    writeFileSync(
      native,
      [
        entry({
          uuid: 'native-user',
          type: 'user',
          promptSource: 'typed',
          message: { role: 'user', content: 'native prompt' },
        }),
        entry({
          uuid: 'native-assistant',
          parentUuid: 'native-user',
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'native answer' }] },
        }),
        entry({
          type: 'last-prompt',
          leafUuid: 'native-assistant',
          sessionId: 'claude-session-1',
        }),
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      stale,
      [
        entry({
          uuid: 'stale-user',
          type: 'user',
          promptSource: 'typed',
          message: { role: 'user', content: 'stale prompt' },
        }),
      ].join('\n'),
      'utf8',
    );

    const history = await Effect.runPromise(
      readClaudeConversation({
        agentSessionId: 10,
        cwd: '/repo/isagi',
        harnessSessionId: 'claude-session-1',
        claudeDirectory,
        streams: [['claude-session-1', [stopRecord(0, stale)]]],
      }),
    );

    assert.deepEqual(history, [
      { role: 'user', parts: [{ type: 'text', text: 'native prompt' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'native answer' }] },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Claude conversation finds native transcript by session id when stored under a different cwd directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-claude-discovered-transcript-'));
  try {
    const claudeDirectory = join(root, '.claude');
    const discovered = nativeClaudeTranscriptPath({
      claudeDirectory,
      cwd: '/repo/actual-cwd',
      harnessSessionId: 'claude-session-1',
    });
    mkdirSync(dirname(discovered), { recursive: true });
    writeFileSync(
      discovered,
      [
        entry({
          uuid: 'discovered-user',
          type: 'user',
          promptSource: 'typed',
          message: { role: 'user', content: 'discovered prompt' },
          sessionId: 'claude-session-1',
        }),
        entry({
          uuid: 'discovered-assistant',
          parentUuid: 'discovered-user',
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'discovered answer' }] },
          sessionId: 'claude-session-1',
        }),
        entry({
          type: 'last-prompt',
          leafUuid: 'discovered-assistant',
          sessionId: 'claude-session-1',
        }),
      ].join('\n'),
      'utf8',
    );

    const history = await Effect.runPromise(
      readClaudeConversation({
        agentSessionId: 10,
        cwd: '/repo/stale-cwd',
        harnessSessionId: 'claude-session-1',
        claudeDirectory,
        streams: [],
      }),
    );

    assert.deepEqual(history, [
      { role: 'user', parts: [{ type: 'text', text: 'discovered prompt' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'discovered answer' }] },
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
