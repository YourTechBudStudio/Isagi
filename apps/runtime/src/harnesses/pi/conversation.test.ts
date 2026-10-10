import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import type { HarnessObservationRecord } from '../projection.js';
import { parsePiTranscript, readPiConversation } from './conversation.js';

test('Pi native transcript follows the active parent chain', () => {
  assert.deepEqual(
    parsePiTranscript(
      transcript([
        session('pi-session-1'),
        transcriptEntry('model_change', 'model', null),
        message('u1', 'model', 'user', 'first prompt'),
        message('a1', 'u1', 'assistant', [{ type: 'text', text: 'first answer' }]),
        transcriptEntry('custom', 'checkpoint', 'a1'),
        message('u2-stale', 'checkpoint', 'user', 'undone prompt'),
        message('a2-stale', 'u2-stale', 'assistant', [{ type: 'text', text: 'undone answer' }]),
        message('u3', 'checkpoint', 'user', 'active prompt'),
        message('a3', 'u3', 'assistant', [{ type: 'text', text: 'active answer' }]),
      ]),
    ),
    [
      { role: 'user', parts: [{ type: 'text', text: 'first prompt' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'first answer' }] },
      { role: 'user', parts: [{ type: 'text', text: 'active prompt' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'active answer' }] },
    ],
  );
});

test('Pi native transcript lookup uses session id and ignores stale hook history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-pi-transcript-'));
  const cwd = '/repo/worktree';
  const sessionsDirectory = join(root, 'agent', 'sessions', '--repo-worktree--');
  mkdirSync(sessionsDirectory, { recursive: true });
  writeFileSync(
    join(sessionsDirectory, '2026-06-29T13-50-04-000Z_pi-session-1.jsonl'),
    transcript([
      session('pi-session-1', cwd),
      transcriptEntry('model_change', 'model', null),
      message('u1', 'model', 'user', 'native prompt'),
      message('a1', 'u1', 'assistant', [{ type: 'text', text: 'native answer' }]),
    ]),
    'utf8',
  );

  assert.deepEqual(
    await Effect.runPromise(
      readPiConversation({
        agentSessionId: 41,
        cwd,
        harnessSessionId: 'pi-session-1',
        piDirectory: root,
        streams: [
          [
            'pi-session-1',
            [
              messageEnd(0, 'user', 'stale prompt'),
              messageEnd(1, 'assistant', [{ type: 'text', text: 'stale answer' }]),
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

function messageEnd(
  seq: number,
  role: 'user' | 'assistant',
  content: unknown,
): HarnessObservationRecord {
  return {
    recordedAt: time(seq),
    seq,
    ptyProcessId: 20,
    harness: 'pi',
    nativeEvent: 'message_end',
    event: {
      nativeEvent: 'message_end',
      event: {
        message: { role, content },
      },
      context: { hasPendingMessages: null },
    },
  };
}

function time(seq: number) {
  return `2026-06-18T00:00:0${seq}.000Z`;
}

function transcript(entries: readonly Record<string, unknown>[]) {
  return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

function session(id: string, cwd = '/repo') {
  return {
    type: 'session',
    version: 3,
    id,
    timestamp: '2026-06-29T00:00:00.000Z',
    cwd,
  };
}

function transcriptEntry(type: string, id: string, parentId: string | null) {
  return {
    type,
    id,
    parentId,
    timestamp: '2026-06-29T00:00:00.000Z',
  };
}

function message(id: string, parentId: string, role: 'user' | 'assistant', content: unknown) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: '2026-06-29T00:00:00.000Z',
    message: { role, content },
  };
}
