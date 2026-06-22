import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { harnessLogPath, testLayer } from '../tests/test-support.js';
import { getConversationHistory } from './conversation.js';
import { AgentSessionArtifacts } from './ledger.js';

test('conversation history reads all harness streams in chronological order', async () => {
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
        return yield* getConversationHistory(10);
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(history, [
      { role: 'user', parts: [{ type: 'text', text: 'first' }] },
      { role: 'user', parts: [{ type: 'text', text: 'second' }] },
    ]);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

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
