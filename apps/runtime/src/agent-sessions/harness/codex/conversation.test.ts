import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import type { HarnessObservationRecord } from '../projection.js';
import { parseCodexTranscript, readCodexConversation } from './conversation.js';

test('Codex native transcript applies persisted thread rollback', () => {
  assert.deepEqual(
    parseCodexTranscript(
      transcript([
        sessionMeta('codex-session-1'),
        userMessage('one'),
        taskComplete('first done'),
        userMessage('two'),
        taskComplete('second done'),
        rollback(1),
      ]),
    ),
    [
      { role: 'user', parts: [{ type: 'text', text: 'one' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'first done' }] },
    ],
  );
});

test('Codex native transcript lookup uses session id and ignores stale hook history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-codex-transcript-'));
  const sessionsDirectory = join(root, 'sessions', '2026', '06', '29');
  mkdirSync(sessionsDirectory, { recursive: true });
  writeFileSync(
    join(sessionsDirectory, 'rollout-2026-06-29T13-50-04-codex-session-1.jsonl'),
    transcript([
      sessionMeta('codex-session-1'),
      userMessage('native prompt'),
      taskComplete('native answer'),
      userMessage('undone prompt'),
      taskComplete('undone answer'),
      rollback(1),
    ]),
    'utf8',
  );

  assert.deepEqual(
    await Effect.runPromise(
      readCodexConversation({
        agentSessionId: 41,
        harnessSessionId: 'codex-session-1',
        codexDirectory: root,
        streams: [
          [
            'codex-session-1',
            [
              record('UserPromptSubmit', 0, { prompt: 'stale prompt' }),
              record('Stop', 1, { last_assistant_message: 'stale answer' }),
            ],
          ],
        ],
      }),
    ),
    [
      { role: 'user', parts: [{ type: 'text', text: 'native prompt' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'native answer' }] },
    ],
  );
});

function record(
  nativeEvent: string,
  seq: number,
  input: Record<string, unknown>,
): HarnessObservationRecord {
  return {
    recordedAt: `2026-06-18T00:00:0${seq}.000Z`,
    seq,
    ptyProcessId: 20,
    harness: 'codex',
    nativeEvent,
    event: {
      nativeEvent,
      notificationType: null,
      input: { hook_event_name: nativeEvent, ...input },
    },
  };
}

function transcript(entries: readonly Record<string, unknown>[]) {
  return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

function sessionMeta(sessionId: string) {
  return {
    timestamp: '2026-06-29T20:50:05.467Z',
    type: 'session_meta',
    payload: {
      session_id: sessionId,
      id: sessionId,
    },
  };
}

function userMessage(message: string) {
  return {
    timestamp: '2026-06-29T20:50:05.540Z',
    type: 'event_msg',
    payload: {
      type: 'user_message',
      message,
    },
  };
}

function taskComplete(lastAgentMessage: string) {
  return {
    timestamp: '2026-06-29T20:50:06.879Z',
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      last_agent_message: lastAgentMessage,
    },
  };
}

function rollback(numTurns: number) {
  return {
    timestamp: '2026-06-29T20:50:21.048Z',
    type: 'event_msg',
    payload: {
      type: 'thread_rolled_back',
      num_turns: numTurns,
    },
  };
}
