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

test('Claude transcript parser includes the assistant tail appended after a last-prompt marker', () => {
  const raw = [
    entry({
      uuid: 'root',
      type: 'system',
      parentUuid: null,
    }),
    entry({
      uuid: 'user-1',
      parentUuid: 'root',
      type: 'user',
      promptSource: 'typed',
      message: { role: 'user', content: 'fix the bug' },
    }),
    entry({
      uuid: 'prompt-attachment',
      parentUuid: 'user-1',
      type: 'attachment',
    }),
    entry({
      type: 'last-prompt',
      leafUuid: 'prompt-attachment',
      sessionId: 'claude-session-1',
    }),
    entry({
      uuid: 'assistant-progress',
      parentUuid: 'prompt-attachment',
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
    }),
    entry({
      uuid: 'tool-result',
      parentUuid: 'assistant-progress',
      type: 'user',
      promptSource: null,
      message: { role: 'user', content: [{ type: 'tool_result', content: 'done' }] },
    }),
    entry({
      uuid: 'assistant-final',
      parentUuid: 'tool-result',
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'fixed' }] },
    }),
    entry({
      uuid: 'stop-summary',
      parentUuid: 'assistant-final',
      type: 'system',
      subtype: 'stop_hook_summary',
    }),
    entry({
      uuid: 'turn-duration',
      parentUuid: 'stop-summary',
      type: 'system',
      subtype: 'turn_duration',
    }),
  ].join('\n');

  assert.deepEqual(parseClaudeTranscript(raw), [
    { role: 'user', parts: [{ type: 'text', text: 'fix the bug' }] },
    {
      role: 'assistant',
      parts: [
        { type: 'text', text: 'working' },
        { type: 'text', text: 'fixed' },
      ],
    },
  ]);
});

test('Claude transcript parser ignores an unrelated untyped fork after a last-prompt marker', () => {
  const raw = [
    entry({
      uuid: 'root',
      type: 'system',
      parentUuid: null,
    }),
    entry({
      uuid: 'active-user',
      parentUuid: 'root',
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
    entry({
      uuid: 'local-command',
      parentUuid: 'root',
      type: 'user',
      promptSource: null,
      message: { role: 'user', content: '<command-name>/copy</command-name>' },
    }),
    entry({
      uuid: 'local-command-output',
      parentUuid: 'local-command',
      type: 'user',
      promptSource: null,
      message: { role: 'user', content: '<local-command-stdout>Copied</local-command-stdout>' },
    }),
  ].join('\n');

  assert.deepEqual(parseClaudeTranscript(raw), [
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

test('Claude conversation appends the terminal Stop message when the native transcript is behind', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-claude-terminal-message-'));
  try {
    const transcript = join(root, 'transcript.jsonl');
    writeFileSync(
      transcript,
      [
        entry({
          uuid: 'user-1',
          type: 'user',
          promptSource: 'typed',
          message: { role: 'user', content: 'revise the artifact' },
        }),
        entry({
          uuid: 'assistant-progress',
          parentUuid: 'user-1',
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'One final consistency fix:' }],
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const history = await Effect.runPromise(
      readClaudeConversation({
        agentSessionId: 10,
        streams: [
          [
            'claude-1',
            [
              promptRecord(0, transcript),
              stopRecord(1, transcript, {
                background_tasks: [],
                last_assistant_message: 'The artifact is complete and ready for review.',
              }),
            ],
          ],
        ],
      }),
    );

    assert.deepEqual(history, [
      { role: 'user', parts: [{ type: 'text', text: 'revise the artifact' }] },
      {
        role: 'assistant',
        parts: [
          { type: 'text', text: 'One final consistency fix:' },
          { type: 'text', text: 'The artifact is complete and ready for review.' },
        ],
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Claude conversation does not duplicate a terminal message already in the transcript', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-claude-terminal-dedupe-'));
  try {
    const transcript = join(root, 'transcript.jsonl');
    writeFileSync(
      transcript,
      [
        entry({
          uuid: 'user-1',
          type: 'user',
          promptSource: 'typed',
          message: { role: 'user', content: 'finish the artifact' },
        }),
        entry({
          uuid: 'assistant-final',
          parentUuid: 'user-1',
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'The artifact is ready.' }],
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const history = await Effect.runPromise(
      readClaudeConversation({
        agentSessionId: 10,
        streams: [
          [
            'claude-1',
            [
              promptRecord(0, transcript),
              stopRecord(1, transcript, {
                background_tasks: [],
                last_assistant_message: 'The artifact is ready.',
              }),
            ],
          ],
        ],
      }),
    );

    assert.deepEqual(history, [
      { role: 'user', parts: [{ type: 'text', text: 'finish the artifact' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'The artifact is ready.' }] },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Claude conversation does not attach a prior terminal message to a newer active turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-claude-active-turn-'));
  try {
    const transcript = join(root, 'transcript.jsonl');
    writeFileSync(
      transcript,
      [
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
          uuid: 'user-2',
          parentUuid: 'assistant-1',
          type: 'user',
          promptSource: 'typed',
          message: { role: 'user', content: 'second prompt' },
        }),
        entry({
          uuid: 'assistant-progress',
          parentUuid: 'user-2',
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
        }),
      ].join('\n'),
      'utf8',
    );

    const history = await Effect.runPromise(
      readClaudeConversation({
        agentSessionId: 10,
        streams: [
          [
            'claude-1',
            [
              promptRecord(0, transcript),
              stopRecord(1, transcript, {
                background_tasks: [],
                last_assistant_message: 'first answer',
              }),
              promptRecord(2, transcript),
            ],
          ],
        ],
      }),
    );

    assert.deepEqual(history, [
      { role: 'user', parts: [{ type: 'text', text: 'first prompt' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'first answer' }] },
      { role: 'user', parts: [{ type: 'text', text: 'second prompt' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'working' }] },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Claude conversation does not reconcile a non-terminal background-work Stop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-claude-background-stop-'));
  try {
    const transcript = join(root, 'transcript.jsonl');
    writeFileSync(
      transcript,
      entry({
        uuid: 'user-1',
        type: 'user',
        promptSource: 'typed',
        message: { role: 'user', content: 'run the review' },
      }),
      'utf8',
    );

    const history = await Effect.runPromise(
      readClaudeConversation({
        agentSessionId: 10,
        streams: [
          [
            'claude-1',
            [
              promptRecord(0, transcript),
              stopRecord(1, transcript, {
                background_tasks: [{ task_id: 'reviewer' }],
                last_assistant_message: 'The reviewer is still running.',
              }),
            ],
          ],
        ],
      }),
    );

    assert.deepEqual(history, [
      { role: 'user', parts: [{ type: 'text', text: 'run the review' }] },
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

test('Claude conversation reads raw Stop transcript_path records', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-claude-raw-hook-transcript-'));
  try {
    const transcript = join(root, 'transcript.jsonl');
    writeFileSync(
      transcript,
      entry({
        uuid: 'user-1',
        type: 'user',
        promptSource: 'typed',
        message: { role: 'user', content: 'raw hook fallback' },
      }),
      'utf8',
    );
    const history = await Effect.runPromise(
      readClaudeConversation({
        agentSessionId: 10,
        streams: [
          [
            'claude-1',
            [
              {
                ...stopRecord(0, transcript),
                event: { hook_event_name: 'Stop', transcript_path: transcript },
              },
            ],
          ],
        ],
      }),
    );
    assert.deepEqual(history, [
      { role: 'user', parts: [{ type: 'text', text: 'raw hook fallback' }] },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function stopRecord(
  seq: number,
  transcriptPath: string,
  event: Record<string, unknown> = {},
): HarnessObservationRecord {
  return {
    recordedAt: `2026-06-18T00:00:0${seq}.000Z`,
    seq,
    ptyProcessId: 20,
    harness: 'claude',
    nativeEvent: 'Stop',
    event: {
      hook_event_name: 'Stop',
      transcript_path: transcriptPath,
      ...event,
    },
  };
}

function promptRecord(seq: number, transcriptPath: string): HarnessObservationRecord {
  return {
    recordedAt: `2026-06-18T00:00:0${seq}.000Z`,
    seq,
    ptyProcessId: 20,
    harness: 'claude',
    nativeEvent: 'UserPromptSubmit',
    event: {
      hook_event_name: 'UserPromptSubmit',
      transcript_path: transcriptPath,
    },
  };
}

function entry(value: Record<string, unknown>) {
  return JSON.stringify(value);
}
