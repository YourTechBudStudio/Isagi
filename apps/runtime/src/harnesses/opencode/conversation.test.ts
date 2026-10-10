import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import BetterSqlite from 'better-sqlite3';
import { Effect } from 'effect';

import { readOpenCodeConversation } from './conversation.js';

test('OpenCode native conversation reads current messages and merges assistant text per turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-opencode-conversation-'));
  seedOpenCodeDatabase(root, {
    sessions: [{ id: 'ses_1' }],
    messages: [
      message('u1', 'ses_1', 1, { role: 'user' }, [part('u1-text', 2, 'text', 'first prompt')]),
      message('a1', 'ses_1', 3, { role: 'assistant', parentID: 'u1' }, [
        part('a1-reasoning', 4, 'reasoning', 'private'),
        part('a1-text', 5, 'text', 'first answer'),
      ]),
      message('a2', 'ses_1', 6, { role: 'assistant', parentID: 'u1' }, [
        part('a2-tool', 7, 'tool', 'tool output'),
        part('a2-text', 8, 'text', 'second answer'),
      ]),
      message('u2', 'ses_1', 9, { role: 'user' }, [part('u2-text', 10, 'text', 'next prompt')]),
      message('a3', 'ses_1', 11, { role: 'assistant', parentID: 'u2' }, [
        part('a3-text', 12, 'text', 'final answer'),
      ]),
    ],
  });

  assert.deepEqual(
    await Effect.runPromise(
      readOpenCodeConversation({
        agentSessionId: 10,
        harnessSessionId: 'ses_1',
        opencodeDirectory: root,
        streams: [],
      }),
    ),
    [
      { role: 'user', parts: [{ type: 'text', text: 'first prompt' }] },
      {
        role: 'assistant',
        parts: [
          { type: 'text', text: 'first answer' },
          { type: 'text', text: 'second answer' },
        ],
      },
      { role: 'user', parts: [{ type: 'text', text: 'next prompt' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'final answer' }] },
    ],
  );
});

test('OpenCode native conversation trims from the session revert message', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-opencode-revert-'));
  seedOpenCodeDatabase(root, {
    sessions: [{ id: 'ses_1', revert: { messageID: 'u2' } }],
    messages: [
      message('u1', 'ses_1', 1, { role: 'user' }, [part('u1-text', 2, 'text', 'kept prompt')]),
      message('a1', 'ses_1', 3, { role: 'assistant', parentID: 'u1' }, [
        part('a1-text', 4, 'text', 'kept answer'),
      ]),
      message('u2', 'ses_1', 5, { role: 'user' }, [part('u2-text', 6, 'text', 'reverted prompt')]),
      message('a2', 'ses_1', 7, { role: 'assistant', parentID: 'u2' }, [
        part('a2-text', 8, 'text', 'reverted answer'),
      ]),
    ],
  });

  assert.deepEqual(
    await Effect.runPromise(
      readOpenCodeConversation({
        agentSessionId: 10,
        harnessSessionId: 'ses_1',
        opencodeDirectory: root,
        streams: [],
      }),
    ),
    [
      { role: 'user', parts: [{ type: 'text', text: 'kept prompt' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'kept answer' }] },
    ],
  );
});

test('OpenCode conversation does not fall back to hook message history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-opencode-missing-'));
  assert.deepEqual(
    await Effect.runPromise(
      readOpenCodeConversation({
        agentSessionId: 10,
        opencodeDirectory: root,
        streams: [
          [
            'ses_1',
            [
              {
                recordedAt: '2026-06-18T00:00:00.000Z',
                seq: 0,
                ptyProcessId: 20,
                harness: 'opencode',
                nativeEvent: 'chat.message',
                event: {
                  nativeEvent: 'chat.message',
                  message: { role: 'user', content: 'stale prompt' },
                },
              },
            ],
          ],
        ],
      }),
    ),
    [],
  );
});

test('OpenCode conversation does not scan other database sessions when pinned session is missing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-opencode-pinned-'));
  seedOpenCodeDatabase(root, {
    sessions: [{ id: 'other-session' }],
    messages: [
      message('u1', 'other-session', 1, { role: 'user' }, [
        part('u1-text', 2, 'text', 'wrong prompt'),
      ]),
      message('a1', 'other-session', 3, { role: 'assistant', parentID: 'u1' }, [
        part('a1-text', 4, 'text', 'wrong answer'),
      ]),
    ],
  });

  assert.deepEqual(
    await Effect.runPromise(
      readOpenCodeConversation({
        agentSessionId: 10,
        harnessSessionId: 'target-session',
        opencodeDirectory: root,
        streams: [],
      }),
    ),
    [],
  );
});

interface SeedInput {
  readonly sessions: readonly {
    readonly id: string;
    readonly revert?: Record<string, unknown> | undefined;
  }[];
  readonly messages: readonly SeedMessage[];
}

interface SeedMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly createdAt: number;
  readonly data: Record<string, unknown>;
  readonly parts: readonly SeedPart[];
}

interface SeedPart {
  readonly id: string;
  readonly createdAt: number;
  readonly data: Record<string, unknown>;
}

function seedOpenCodeDatabase(root: string, input: SeedInput) {
  mkdirSync(root, { recursive: true });
  const database = new BetterSqlite(join(root, 'opencode.db'));
  try {
    database.exec(`
      create table session (
        id text primary key,
        revert text
      );
      create table message (
        id text primary key,
        session_id text not null,
        time_created integer not null,
        data text not null
      );
      create table part (
        id text primary key,
        message_id text not null,
        session_id text not null,
        time_created integer not null,
        data text not null
      );
    `);

    const insertSession = database.prepare('insert into session (id, revert) values (?, ?)');
    for (const session of input.sessions) {
      insertSession.run(session.id, session.revert ? JSON.stringify(session.revert) : null);
    }

    const insertMessage = database.prepare(
      'insert into message (id, session_id, time_created, data) values (?, ?, ?, ?)',
    );
    const insertPart = database.prepare(
      'insert into part (id, message_id, session_id, time_created, data) values (?, ?, ?, ?, ?)',
    );
    for (const messageInput of input.messages) {
      insertMessage.run(
        messageInput.id,
        messageInput.sessionId,
        messageInput.createdAt,
        JSON.stringify(messageInput.data),
      );
      for (const partInput of messageInput.parts) {
        insertPart.run(
          partInput.id,
          messageInput.id,
          messageInput.sessionId,
          partInput.createdAt,
          JSON.stringify(partInput.data),
        );
      }
    }
  } finally {
    database.close();
  }
}

function message(
  id: string,
  sessionId: string,
  createdAt: number,
  data: Record<string, unknown>,
  parts: readonly SeedPart[],
): SeedMessage {
  return { id, sessionId, createdAt, data, parts };
}

function part(id: string, createdAt: number, type: string, text: string): SeedPart {
  return {
    id,
    createdAt,
    data: { type, text },
  };
}
