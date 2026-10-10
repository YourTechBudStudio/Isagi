import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Layer } from 'effect';

import { makeLogCapture, runScoped } from '@isagi/testing';

import { sanitizeText, UpdaterDiagnostics, type UpdaterDiagnosticRecord } from './diagnostics.js';
import { testConfig } from './test-support.js';

/** The real trail, writing under `directory`, with its log lines captured. */
function trail(directory: string) {
  const logs = makeLogCapture();
  const layer = UpdaterDiagnostics.layer.pipe(
    Layer.provide(testConfig({ logsDirectory: () => directory })),
    Layer.provideMerge(logs.layer),
  );
  return { logs: logs.lines, layer };
}

const credentialBearingSamples = [
  {
    name: 'signed release-asset redirect',
    text: 'HTTP 403 for https://isagi-releases.s3.amazonaws.com/Isagi-2.0.0-arm64.zip?X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20260730%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Signature=deadbeefcafe&X-Amz-Security-Token=FwoGZXIvYXdz',
    secrets: ['AKIAIOSFODNN7EXAMPLE', 'deadbeefcafe', 'FwoGZXIvYXdz'],
  },
  {
    name: 'github token in prose',
    text: 'Feed request failed with token ghp_0123456789abcdefghijklmnopqrstuvwxyz.',
    secrets: ['ghp_0123456789abcdefghijklmnopqrstuvwxyz'],
  },
  {
    name: 'fine-grained github pat',
    text: 'auth rejected: github_pat_11ABCDEFG0abcdefghijklmnop_qrstuvwxyz012345',
    secrets: ['github_pat_11ABCDEFG0abcdefghijklmnop_qrstuvwxyz012345'],
  },
  {
    name: 'unrecognized secret query keys',
    text: 'GET https://updates.example.test/latest.yml?sig=abcd1234&jwt=zzzzzzzz&secret=hunter2&channel=stable',
    secrets: ['abcd1234', 'zzzzzzzz', 'hunter2'],
  },
  {
    name: 'fragment-carried credential',
    text: 'redirect to https://updates.example.test/callback#access_token=frag-secret-value',
    secrets: ['frag-secret-value'],
  },
  {
    name: 'basic credentials in url userinfo',
    text: 'https://deploy:s3cr3t-pass@updates.example.test/latest.yml',
    secrets: ['s3cr3t-pass'],
  },
  {
    name: 'authorization and cookie headers',
    text: 'authorization: Bearer abc.def.ghi\ncookie: session=zzz-session-value',
    secrets: ['abc.def.ghi', 'zzz-session-value'],
  },
  {
    name: 'labeled secrets outside a url',
    text: 'provider config rejected (token=hidden-token, client_secret: shhh-value)',
    secrets: ['hidden-token', 'shhh-value'],
  },
  {
    name: 'json-serialized labeled secrets',
    text: 'feed rejected {"token":"json-token-value","api_key":"json-key-value","authorization":"Bearer json-header-value"}',
    secrets: ['json-token-value', 'json-key-value', 'json-header-value'],
  },
  {
    name: 'quoted configuration values',
    text: `token="double-quoted-value" client_secret='single-quoted-value' api_key = "spaced-quoted-value"`,
    secrets: ['double-quoted-value', 'single-quoted-value', 'spaced-quoted-value'],
  },
  {
    name: 'json web token',
    text: 'rejected eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    secrets: ['dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'],
  },
];

test('updater diagnostics redact credential-bearing failure text', () => {
  for (const { name, text, secrets } of credentialBearingSamples) {
    const sanitized = sanitizeText(text);
    for (const secret of secrets)
      assert.equal(sanitized.includes(secret), false, `${name} leaked ${secret}: ${sanitized}`);
  }
});

test('updater diagnostics keep non-secret failure context readable', () => {
  const sanitized = sanitizeText(
    'ENOTFOUND while fetching https://updates.example.test/stable/latest.yml for 2.0.0',
  );
  assert.equal(sanitized.includes('ENOTFOUND'), true);
  assert.equal(sanitized.includes('https://updates.example.test/stable/latest.yml'), true);
  assert.equal(sanitized.includes('2.0.0'), true);
});

test('diagnostics serialize writes, redact before truncation, and rotate by UTF-8 bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'isagi-updater-diagnostics-'));
  const subject = trail(directory);
  const secret =
    'https://user:password@example.test/release?token=hidden&X-Amz-Signature=signaturevalue ghp_0123456789abcdefghijklmnopqrstuvwxyz {"api_key":"jsonsecret"}';
  const records = Array.from(
    { length: 80 },
    (_, index): UpdaterDiagnosticRecord => ({
      operation: 'download',
      platform: 'darwin',
      installedVersion: '1.2.3',
      targetVersion: '2.0.0',
      code: `failure_${index}`,
      summary: `${secret} ${'界'.repeat(2_000)}`,
    }),
  );
  await runScoped(
    Effect.gen(function* () {
      const diagnostics = yield* UpdaterDiagnostics;
      // Started together: the trail itself serializes them.
      yield* Effect.all(records.map(diagnostics.write), { concurrency: 'unbounded' });
    }).pipe(Effect.provide(subject.layer)),
  );

  const currentPath = join(directory, 'updater.jsonl');
  const previousPath = join(directory, 'updater.previous.jsonl');
  const combined = `${await readFile(previousPath, 'utf8')}\n${await readFile(currentPath, 'utf8')}`;
  assert.equal(combined.includes('password'), false);
  assert.equal(combined.includes('hidden'), false);
  assert.equal(combined.includes('signaturevalue'), false);
  assert.equal(combined.includes('ghp_0123456789abcdefghijklmnopqrstuvwxyz'), false);
  assert.equal(combined.includes('jsonsecret'), false);
  assert.equal((await stat(currentPath)).size <= 256 * 1024, true);
  assert.equal((await stat(previousPath)).size <= 256 * 1024, true);
  assert.deepEqual(subject.logs, []);
  for (const line of combined.split('\n').filter(Boolean))
    assert.doesNotThrow(() => JSON.parse(line));
});

test('a trail that cannot be written warns once and never fails the updater', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'isagi-updater-diagnostics-'));
  // A file where the logs directory should be: every append fails.
  const blocked = join(directory, 'logs');
  await writeFile(blocked, 'not a directory');
  const subject = trail(blocked);
  const record: UpdaterDiagnosticRecord = {
    operation: 'check',
    platform: 'darwin',
    installedVersion: '1.2.3',
    code: 'updater_error',
    summary: 'no provider',
  };
  await runScoped(
    Effect.gen(function* () {
      const diagnostics = yield* UpdaterDiagnostics;
      yield* diagnostics.write(record);
      yield* diagnostics.write(record);
    }).pipe(Effect.provide(subject.layer)),
  );
  assert.deepEqual(
    subject.logs.map((line) => [line.level, line.message]),
    [['Warn', 'Updater diagnostics could not be persisted.']],
  );
});

test('the logs directory is not asked for until the first record is written', async () => {
  // A development build never writes one, so it never asks Electron for its logs path.
  let asked = 0;
  await runScoped(
    Effect.gen(function* () {
      yield* UpdaterDiagnostics;
    }).pipe(
      Effect.provide(
        UpdaterDiagnostics.layer.pipe(
          Layer.provide(
            testConfig({
              logsDirectory: () => {
                asked += 1;
                return tmpdir();
              },
            }),
          ),
        ),
      ),
    ),
  );
  assert.equal(asked, 0);
});
