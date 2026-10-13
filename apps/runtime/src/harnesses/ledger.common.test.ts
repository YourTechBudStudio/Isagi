import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { codexHookSource } from './codex/artifacts.js';
import { commandHookSource } from './ledger.common.js';
import { parseJsonlRecord } from './ledger.js';

test('command hook skips malformed routing input without leaking raw stdin', () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-hook-malformed-'));
  try {
    const script = join(root, 'hook.mjs');
    writeFileSync(script, commandHookSource('claude'), 'utf8');
    const result = runHook(script, root, '{this is not json');
    assert.equal(result.status, 0);
    assert.match(
      result.stderr,
      /^\[isagi\] Harness observation skipped: malformed hook input\.\n$/,
    );
    assert.equal(result.stderr.includes('this is not json'), false);
    assert.equal(existsSync(join(root, 'artifacts')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('command hook persists complete routable native input even when optional fields are malformed', () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-hook-raw-'));
  try {
    const script = join(root, 'hook.mjs');
    writeFileSync(script, commandHookSource('claude'), 'utf8');
    const input = {
      session_id: 'session-redacted',
      hook_event_name: 'Stop',
      background_tasks: 'unexpected-shape',
      error_details: { message: 'redacted' },
      future_field: ['preserved'],
    };
    const result = runHook(script, root, JSON.stringify(input));
    assert.equal(result.status, 0);
    const artifactDirectory = join(root, 'artifacts');
    const line = readFileSync(
      join(artifactDirectory, `${Buffer.from('session-redacted').toString('hex')}.harness.jsonl`),
      'utf8',
    ).trim();
    const record = JSON.parse(line) as { readonly event: unknown };
    assert.deepEqual(record.event, input);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Codex command hook records SessionStart without mutating resumable metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-hook-codex-'));
  try {
    const script = join(root, 'hook.mjs');
    writeFileSync(script, codexHookSource(), 'utf8');
    const input = {
      session_id: 'side-session-redacted',
      hook_event_name: 'SessionStart',
      source: 'startup',
      transcript_path: null,
    };
    const result = runHook(script, root, JSON.stringify(input));
    assert.equal(result.status, 0);
    const artifactDirectory = join(root, 'artifacts');
    assert.equal(existsSync(join(artifactDirectory, 'harness.json')), false);
    const line = readFileSync(
      join(
        artifactDirectory,
        `${Buffer.from('side-session-redacted').toString('hex')}.harness.jsonl`,
      ),
      'utf8',
    ).trim();
    const record = JSON.parse(line) as { readonly event: unknown };
    assert.deepEqual(record.event, input);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('command hook marks each record with exactly the execution it ran under', () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-hook-execution-'));
  try {
    const script = join(root, 'hook.mjs');
    writeFileSync(script, commandHookSource('claude'), 'utf8');
    const input = (sessionId: string) =>
      JSON.stringify({ session_id: sessionId, hook_event_name: 'Stop' });
    const marker = (sessionId: string) => {
      const line = readFileSync(
        join(root, 'artifacts', `${Buffer.from(sessionId).toString('hex')}.harness.jsonl`),
        'utf8',
      ).trim();
      const record = JSON.parse(line) as Record<string, unknown>;
      return [record.ptyProcessId, record.sdkExecutionId];
    };

    assert.equal(runHook(script, root, input('pty-session')).status, 0);
    assert.equal(
      runHook(script, root, input('sdk-session'), { ISAGI_SDK_EXECUTION_ID: 'execution-1' }).status,
      0,
    );
    assert.equal(
      runHook(script, root, input('empty-session'), { ISAGI_SDK_EXECUTION_ID: '' }).status,
      0,
    );

    assert.deepEqual(marker('pty-session'), [20, null]);
    assert.deepEqual(marker('sdk-session'), [null, 'execution-1']);
    assert.deepEqual(marker('empty-session'), [null, null]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ledger records read a missing SDK execution marker as null and reject a malformed one', () => {
  const line = (fields: Record<string, unknown>) =>
    JSON.stringify({
      schemaVersion: 1,
      recordedAt: '2026-07-09T00:00:00.000Z',
      agentSessionId: 10,
      harnessSessionId: 'session',
      ptyProcessId: null,
      harness: 'claude',
      nativeEvent: 'Stop',
      event: {},
      ...fields,
    });

  assert.equal(parseJsonlRecord(line({ ptyProcessId: 20 }))?.sdkExecutionId, null);
  assert.equal(parseJsonlRecord(line({ sdkExecutionId: null }))?.sdkExecutionId, null);
  assert.equal(
    parseJsonlRecord(line({ sdkExecutionId: 'execution-1' }))?.sdkExecutionId,
    'execution-1',
  );
  assert.equal(parseJsonlRecord(line({ sdkExecutionId: '' })), null);
  assert.equal(parseJsonlRecord(line({ sdkExecutionId: 7 })), null);
});

function runHook(
  script: string,
  root: string,
  input: string,
  execution: NodeJS.ProcessEnv = { ISAGI_PTY_PROCESS_ID: '20' },
) {
  // Only the execution marker this run names may reach the hook.
  const inherited: NodeJS.ProcessEnv = { ...process.env };
  delete inherited.ISAGI_PTY_PROCESS_ID;
  delete inherited.ISAGI_SDK_EXECUTION_ID;
  return spawnSync(process.execPath, [script], {
    input,
    encoding: 'utf8',
    env: {
      ...inherited,
      ISAGI_AGENT_SESSION_ID: '10',
      ISAGI_HARNESS_ARTIFACT_DIRECTORY: join(root, 'artifacts'),
      ISAGI_HARNESS_METADATA_PATH: join(root, 'artifacts', 'harness.json'),
      ...execution,
    },
  });
}
