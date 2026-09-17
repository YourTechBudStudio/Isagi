import assert from 'node:assert/strict';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Either } from 'effect';

import { HarnessLedgerObserver, HarnessObserverRefreshError } from '../harness/observer.service.js';
import { seedActiveAgentSession, testLayer } from './test-support.js';

test('explicit turn refresh tails native events without waiting for the background poll', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-observer-refresh-'));
  try {
    await seedActiveAgentSession(root, 'claude');
    const harnessSessionId = 'refresh-session';
    const directory = join(root, 'sessions', 'agent-sessions', '10');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'harness.json'),
      JSON.stringify({ schemaVersion: 1, harnessSessionId, updatedAt: '2026-09-13T00:00:00.000Z' }),
    );
    const path = join(directory, `${Buffer.from(harnessSessionId).toString('hex')}.harness.jsonl`);
    const record = (second: number, nativeEvent: string, event: unknown) =>
      `${JSON.stringify({
        schemaVersion: 1,
        agentSessionId: 10,
        harnessSessionId,
        ptyProcessId: 20,
        harness: 'claude',
        recordedAt: new Date(Date.UTC(2026, 8, 13, 0, 0, second)).toISOString(),
        nativeEvent,
        event,
      })}\n`;
    writeFileSync(
      path,
      record(0, 'UserPromptSubmit', { prompt_id: 'failed' }) +
        record(1, 'StopFailure', { prompt_id: 'failed' }),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* HarnessLedgerObserver;
        assert.equal((yield* observer.getTurnEdges(10)).at(-1)?.type, 'turn_failed');
        appendFileSync(
          path,
          record(2, 'UserPromptSubmit', { prompt_id: 'continued' }) +
            record(3, 'Stop', {
              prompt_id: 'continued',
              background_tasks: [],
              last_assistant_message: 'finished',
            }),
        );
        const refreshed = yield* observer.refreshTurnEdges(10);
        assert.deepEqual(
          refreshed.map((edge) => [edge.type, edge.seq]),
          [
            ['turn_started', 0],
            ['turn_failed', 0],
            ['turn_started', 2],
            ['turn_ended', 2],
          ],
        );
        assert.equal(refreshed, yield* observer.getTurnEdges(10));
        unlinkSync(path);
        const unavailable = yield* observer.refreshTurnEdges(10).pipe(Effect.either);
        assert.ok(Either.isLeft(unavailable));
        assert.ok(unavailable.left instanceof HarnessObserverRefreshError);
        assert.ok(
          unavailable.left.failedSources.includes(
            realpathSync.native(directory) + path.slice(directory.length),
          ),
        );
      }).pipe(Effect.provide(testLayer(root))),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
