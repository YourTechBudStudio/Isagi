// CLI smoke: the built `isagi` bundle against a real booted runtime. CLI commands, flags, exit codes
// and error codes are a public surface (agents script against them through the shipped skill), so
// this pins what `workflows runs list` and `workflows runs show` print and return end to end.
//
// It lives in the CLI package, which depends on the runtime: the runtime is booted in-process
// through `@isagi/runtime/testing`. The bundle is this package's `dist/isagi.mjs`, built by
// `pnpm build` before `test:built` runs.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { bootRuntime, type BootedRuntime } from '@isagi/runtime/testing';

describe('cli smoke', () => {
  let runtime: BootedRuntime | undefined;
  let dataDir: string | undefined;
  before(async () => {
    assert.ok(existsSync(cliBundlePath), `Build the CLI first: pnpm -C apps/cli build`);
    dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-cli-smoke-data-')));
    // `bootRuntime` injects `startAtBoot: false`, so nothing downloads.
    runtime = await bootRuntime({ dataDirectory: dataDir });
  });

  after(async () => {
    await runtime?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  test('workflows runs list --json prints one page document and exits 0', async () => {
    assert.ok(runtime);
    const result = await runCli([
      'workflows',
      'runs',
      'list',
      '--json',
      '--runtime-url',
      runtime.url,
    ]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stderr, '');
    const document = parseSingleJsonDocument(result.stdout);
    assert.deepEqual(Object.keys(document).sort(), ['items', 'nextCursor']);
    assert.deepEqual(document, { items: [], nextCursor: null });
  });

  test('workflows runs show of an unknown run --json prints the runtime error document and exits 1', async () => {
    assert.ok(runtime);
    const result = await runCli([
      'workflows',
      'runs',
      'show',
      '999999',
      '--json',
      '--runtime-url',
      runtime.url,
    ]);
    assert.equal(result.exitCode, 1, result.stderr);
    assert.equal(result.stderr, '');
    const document = parseSingleJsonDocument(result.stdout);
    assert.deepEqual(Object.keys(document), ['error']);
    const error = document.error as Record<string, unknown>;
    assert.deepEqual(Object.keys(error).sort(), [
      'code',
      'context',
      'data',
      'message',
      'reason',
      'recovery',
      'requestId',
    ]);
    assert.equal(error.code, 'workflow_rejected');
    assert.equal(error.reason, 'workflow_run_not_found');
    assert.deepEqual(error.data, { workflowRunId: 999_999, reason: 'workflow_run_not_found' });
    assert.ok(typeof error.message === 'string' && error.message !== '');
    assert.ok(typeof error.requestId === 'string' && error.requestId !== '');
  });
});

/** This package's built bundle. */
const cliBundlePath = fileURLToPath(new URL('../../dist/isagi.mjs', import.meta.url));

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs the bundle in a child process. Asynchronous on purpose: the runtime answering it lives in
 * this process, so a synchronous spawn would block the very event loop that serves the request.
 */
function runCli(args: readonly string[]): Promise<CliResult> {
  const env = { ...process.env };
  delete env.ISAGI_RUNTIME_URL;
  return new Promise((resolvePromise, reject) => {
    execFile(
      process.execPath,
      [cliBundlePath, ...args],
      { env, timeout: 10_000 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') {
          reject(error);
          return;
        }
        resolvePromise({ exitCode: error ? Number(error.code) : 0, stdout, stderr });
      },
    );
  });
}

/** With `--json`, stdout carries exactly one JSON document on one line. */
function parseSingleJsonDocument(stdout: string): Record<string, unknown> {
  assert.ok(stdout.endsWith('\n'), 'stdout ends with a newline');
  const lines = stdout.slice(0, -1).split('\n');
  assert.equal(lines.length, 1, `stdout is one line: ${stdout}`);
  const parsed: unknown = JSON.parse(lines[0] ?? '');
  assert.ok(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
}
