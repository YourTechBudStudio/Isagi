import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import BetterSqlite from 'better-sqlite3';
import { Effect } from 'effect';

import { readClaudeConversation } from './claude/conversation.js';
import { readCodexConversation } from './codex/conversation.js';
import type { HarnessConversationTurn } from './definition-types.js';
import { readOpenCodeConversation } from './opencode/conversation.js';
import { readPiConversation } from './pi/conversation.js';
import type { HarnessObservationRecord } from './projection.js';

const time = (second: number) => new Date(Date.UTC(2026, 8, 13, 0, 0, second)).toISOString();
const turn: HarnessConversationTurn = {
  harnessSessionId: 'session',
  seq: 2,
  startedAt: time(2),
  completedAt: time(4),
};
const expected = [{ role: 'assistant', parts: [{ type: 'text', text: 'selected response' }] }];
const jsonl = (entries: readonly unknown[]) =>
  `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;

test('Claude recovery reads the exact completed Stop, not a newer prompt response', async () => {
  const record = (
    seq: number,
    second: number,
    nativeEvent: string,
    event: unknown,
  ): HarnessObservationRecord => ({
    seq,
    recordedAt: time(second),
    ptyProcessId: 1,
    harness: 'claude',
    nativeEvent,
    event,
  });
  const streams: readonly [string, readonly HarnessObservationRecord[]][] = [
    [
      'session',
      [
        record(0, 0, 'UserPromptSubmit', { prompt_id: 'old' }),
        record(1, 1, 'StopFailure', { prompt_id: 'old', error: 'anything' }),
        record(2, 2, 'UserPromptSubmit', { prompt_id: 'recovery' }),
        record(3, 4, 'Stop', {
          prompt_id: 'recovery',
          background_tasks: [],
          last_assistant_message: 'selected response',
        }),
        record(4, 5, 'UserPromptSubmit', { prompt_id: 'newer' }),
        record(5, 7, 'Stop', {
          prompt_id: 'newer',
          background_tasks: [],
          last_assistant_message: 'wrong newer response',
        }),
      ],
    ],
  ];
  assert.deepEqual(
    await Effect.runPromise(readClaudeConversation({ agentSessionId: 142, streams, turn })),
    expected,
  );
  assert.deepEqual(
    await Effect.runPromise(
      readClaudeConversation({ agentSessionId: 142, streams, turn: { ...turn, seq: 999 } }),
    ),
    [],
  );
});

test('Codex recovery fences native entries by the selected native start and completion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-codex-turn-'));
  try {
    const path = join(root, 'rollout.jsonl');
    const event = (second: number, payload: unknown) => ({
      timestamp: time(second),
      type: 'event_msg',
      payload,
    });
    writeFileSync(
      path,
      jsonl([
        { type: 'session_meta', payload: { id: 'session' } },
        event(0, { type: 'task_started', turn_id: 'old' }),
        event(1, { type: 'turn_aborted', turn_id: 'old' }),
        event(2, { type: 'task_started', turn_id: 'recovery' }),
        event(3, {
          type: 'item_completed',
          item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'selected response' }] },
        }),
        event(4, { type: 'task_complete', turn_id: 'recovery' }),
        event(5, { type: 'task_started', turn_id: 'newer' }),
        event(6, {
          type: 'item_completed',
          item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'wrong newer response' }] },
        }),
        event(7, { type: 'task_complete', turn_id: 'newer' }),
      ]),
    );
    const input = {
      agentSessionId: 142,
      harnessSessionId: 'session',
      codexDirectory: root,
      streams: [
        [
          'session',
          [
            {
              seq: 0,
              recordedAt: time(0),
              ptyProcessId: 1,
              harness: 'codex',
              nativeEvent: 'SessionStart',
              event: { transcript_path: path },
            },
          ],
        ],
      ] as readonly [string, readonly HarnessObservationRecord[]][],
    };
    assert.deepEqual(await Effect.runPromise(readCodexConversation({ ...input, turn })), expected);
    assert.deepEqual(
      await Effect.runPromise(
        readCodexConversation({ ...input, turn: { ...turn, completedAt: time(7) } }),
      ),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Pi recovery cuts the transcript before following its branch and excludes old responses', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-pi-turn-'));
  try {
    const directory = join(root, 'agent', 'sessions', '--repo--');
    mkdirSync(directory, { recursive: true });
    const message = (id: string, parentId: string | null, second: number, text: string) => ({
      type: 'message',
      id,
      parentId,
      timestamp: time(second),
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    });
    writeFileSync(
      join(directory, 'fixture_session.jsonl'),
      jsonl([
        { type: 'session', id: 'session', timestamp: time(0) },
        message('old', null, 1, 'wrong older response'),
        message('recovery', 'old', 3, 'selected response'),
        // This later branch deliberately drops the selected response.
        message('newer', 'old', 6, 'wrong newer response'),
      ]),
    );
    const input = {
      agentSessionId: 142,
      cwd: '/repo',
      harnessSessionId: 'session',
      piDirectory: root,
      streams: [],
    };
    assert.deepEqual(await Effect.runPromise(readPiConversation({ ...input, turn })), expected);
    assert.deepEqual(
      await Effect.runPromise(
        readPiConversation({
          ...input,
          turn: { ...turn, startedAt: time(4), completedAt: time(5) },
        }),
      ),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('OpenCode recovery reads only assistant messages completed within the selected turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-opencode-turn-'));
  try {
    const db = new BetterSqlite(join(root, 'opencode.db'));
    try {
      db.exec(
        'create table session (id text, revert text); create table message (id text, session_id text, time_created integer, data text); create table part (id text, message_id text, time_created integer, data text)',
      );
      db.prepare('insert into session values (?, null)').run('session');
      for (const [id, second, text] of [
        ['old', 1, 'wrong older response'],
        ['recovery', 3, 'selected response'],
        ['newer', 6, 'wrong newer response'],
      ] as const) {
        const created = Date.parse(time(second));
        db.prepare('insert into message values (?, ?, ?, ?)').run(
          id,
          'session',
          created,
          JSON.stringify({ role: 'assistant', time: { completed: created } }),
        );
        db.prepare('insert into part values (?, ?, ?, ?)').run(
          `${id}-text`,
          id,
          created,
          JSON.stringify({ type: 'text', text }),
        );
      }
    } finally {
      db.close();
    }
    const input = {
      agentSessionId: 142,
      harnessSessionId: 'session',
      opencodeDirectory: root,
      streams: [],
    };
    assert.deepEqual(
      await Effect.runPromise(readOpenCodeConversation({ ...input, turn })),
      expected,
    );
    assert.deepEqual(
      await Effect.runPromise(
        readOpenCodeConversation({
          ...input,
          turn: { ...turn, startedAt: time(4), completedAt: time(5) },
        }),
      ),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
