import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { commandHookSource } from './ledger.common.js';

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

function runHook(script: string, root: string, input: string) {
  return spawnSync(process.execPath, [script], {
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      ISAGI_AGENT_SESSION_ID: '10',
      ISAGI_PTY_PROCESS_ID: '20',
      ISAGI_HARNESS_ARTIFACT_DIRECTORY: join(root, 'artifacts'),
      ISAGI_HARNESS_METADATA_PATH: join(root, 'artifacts', 'harness.json'),
    },
  });
}
