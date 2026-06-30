import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { harnessLogPath, testLayer } from '../tests/test-support.js';
import { getConversationHistory } from './conversation.js';
import { AgentSessionArtifacts } from './ledger.js';

test('conversation history ignores hook-derived message records', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-conversation-history-'));
  try {
    const history = await Effect.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* AgentSessionArtifacts;
        const paths = yield* artifacts.prepareProcessArtifacts({
          agentSessionId: 10,
          ptyProcessId: 20,
        });
        appendPiMessage(harnessLogPath(paths.directory, 'pi-session-z'), {
          harnessSessionId: 'pi-session-z',
          recordedAt: '2026-06-18T00:00:10.000Z',
          seq: 0,
          role: 'user',
          content: 'second',
        });
        appendPiMessage(harnessLogPath(paths.directory, 'pi-session-a'), {
          harnessSessionId: 'pi-session-a',
          recordedAt: '2026-06-18T00:00:00.000Z',
          seq: 0,
          role: 'user',
          content: 'first',
        });
        return yield* getConversationHistory({
          id: 10,
          harness: 'pi',
          cwd: '/repo/isagi',
          harnessSessionId: 'pi-session-z',
        });
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(history, []);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('conversation history does not fall through from a pinned session to another readable stream', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-conversation-pinned-'));
  try {
    const transcriptPath = join(dataRoot, 'other-claude.jsonl');
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: 'user',
        uuid: 'u1',
        promptSource: 'typed',
        message: { content: 'wrong prompt' },
      })}\n${JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        message: { content: [{ type: 'text', text: 'wrong answer' }] },
      })}\n`,
      'utf8',
    );

    const history = await Effect.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* AgentSessionArtifacts;
        const paths = yield* artifacts.prepareProcessArtifacts({
          agentSessionId: 10,
          ptyProcessId: 20,
        });
        appendClaudeStop(harnessLogPath(paths.directory, 'other-claude-session'), {
          harnessSessionId: 'other-claude-session',
          transcriptPath,
        });

        return yield* getConversationHistory({
          id: 10,
          harness: 'claude',
          cwd: '/repo/isagi',
          harnessSessionId: 'target-claude-session',
        });
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(history, []);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

function appendClaudeStop(
  path: string,
  input: {
    readonly harnessSessionId: string;
    readonly transcriptPath: string;
  },
) {
  appendFileSync(
    path,
    `${JSON.stringify({
      schemaVersion: 1,
      recordedAt: '2026-06-18T00:00:00.000Z',
      agentSessionId: 10,
      harnessSessionId: input.harnessSessionId,
      ptyProcessId: 20,
      harness: 'claude',
      nativeEvent: 'Stop',
      event: {
        nativeEvent: 'Stop',
        input: {
          transcript_path: input.transcriptPath,
        },
      },
    })}\n`,
    'utf8',
  );
}

function appendPiMessage(
  path: string,
  input: {
    readonly harnessSessionId: string;
    readonly recordedAt: string;
    readonly seq: number;
    readonly role: 'user' | 'assistant';
    readonly content: unknown;
  },
) {
  appendFileSync(
    path,
    `${JSON.stringify({
      schemaVersion: 1,
      recordedAt: input.recordedAt,
      agentSessionId: 10,
      harnessSessionId: input.harnessSessionId,
      ptyProcessId: 20,
      harness: 'pi',
      nativeEvent: 'message_end',
      event: {
        nativeEvent: 'message_end',
        event: {
          message: { role: input.role, content: input.content },
        },
      },
    })}\n`,
    'utf8',
  );
}
