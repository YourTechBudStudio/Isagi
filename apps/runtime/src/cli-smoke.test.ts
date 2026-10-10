// CLI smoke: the built `isagi` bundle against a real booted runtime. CLI commands, flags, exit codes
// and error codes are a public surface (agents script against them through the shipped skill), so
// this pins what `runs list` and `runs show` print and return end to end. Pinned values were
// observed on v3.
//
// It lives in the runtime package because the CLI cannot import the runtime (the runtime already
// depends on `@isagi/cli`). The bundle is `apps/cli/dist/isagi.mjs`, built by the runtime's
// `workspace-deps` step before every runtime test run.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { Effect } from 'effect';
import type { FastifyInstance } from 'fastify';

import { startRuntimeServer } from './server.js';

describe('cli smoke', () => {
  let runtime: { readonly server: FastifyInstance; readonly url: string } | undefined;
  let dataDir: string | undefined;
  const savedEnvironment = new Map(
    (['ISAGI_DATA_DIR', 'ISAGI_EDITOR_CAPABILITY', 'ISAGI_ALLOWED_ORIGINS'] as const).map(
      (name) => [name, process.env[name]],
    ),
  );

  before(async () => {
    assert.ok(existsSync(cliBundlePath), `Build the CLI first: pnpm -C apps/cli build`);
    dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-cli-smoke-data-')));
    process.env.ISAGI_DATA_DIR = dataDir;
    // Editor provisioning reports `not_applicable` without a capability, so nothing downloads.
    delete process.env.ISAGI_EDITOR_CAPABILITY;
    delete process.env.ISAGI_ALLOWED_ORIGINS;
    runtime = await Effect.runPromise(startRuntimeServer());
  });

  after(async () => {
    await runtime?.server.close();
    for (const [name, value] of savedEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  test('runs list --json prints one page document and exits 0', async () => {
    assert.ok(runtime);
    const result = await runCli(['runs', 'list', '--json', '--runtime-url', runtime.url]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stderr, '');
    const document = parseSingleJsonDocument(result.stdout);
    assert.deepEqual(Object.keys(document).sort(), ['items', 'nextCursor']);
    assert.deepEqual(document, { items: [], nextCursor: null });
  });

  test('runs show of an unknown run --json prints the runtime error document and exits 1', async () => {
    assert.ok(runtime);
    const result = await runCli(['runs', 'show', '999999', '--json', '--runtime-url', runtime.url]);
    assert.equal(result.exitCode, 1, result.stderr);
    assert.equal(result.stderr, '');
    const document = parseSingleJsonDocument(result.stdout);
    assert.deepEqual(Object.keys(document), ['error']);
    const error = document.error as Record<string, unknown>;
    assert.deepEqual(Object.keys(error).sort(), ['code', 'data', 'message', 'reason', 'requestId']);
    assert.equal(error.code, 'workflow_rejected');
    assert.equal(error.reason, 'workflow_run_not_found');
    assert.deepEqual(error.data, { workflowRunId: 999_999, reason: 'workflow_run_not_found' });
    assert.ok(typeof error.message === 'string' && error.message !== '');
    assert.ok(typeof error.requestId === 'string' && error.requestId !== '');
  });
});

/** The bundle next to the CLI package, located through the package so it survives file moves. */
const cliBundlePath = resolve(
  dirname(createRequire(import.meta.url).resolve('@isagi/cli/commands')),
  '../../dist/isagi.mjs',
);

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
