import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { locateCodexRolloutPaths } from './native-artifacts.js';

test('Codex index-only lookup does not recursively scan native session storage', async () => {
  const codexDirectory = mkdtempSync(join(tmpdir(), 'isagi-codex-locator-'));
  try {
    const harnessSessionId = 'codex-session-redacted';
    const directory = join(codexDirectory, 'sessions', '2026', '07', '09');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `rollout-test-${harnessSessionId}.jsonl`);
    writeFileSync(
      path,
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: harnessSessionId },
      })}\n`,
    );
    const indexOnly = await Effect.runPromise(
      locateCodexRolloutPaths({
        agentSessionId: 10,
        harnessSessionId,
        codexDirectory,
        discovery: 'index_only',
      }),
    );
    const full = await Effect.runPromise(
      locateCodexRolloutPaths({
        agentSessionId: 10,
        harnessSessionId,
        codexDirectory,
        discovery: 'full',
      }),
    );
    assert.deepEqual(indexOnly, []);
    assert.deepEqual(full, [{ harnessSessionId, path }]);
  } finally {
    rmSync(codexDirectory, { recursive: true, force: true });
  }
});
