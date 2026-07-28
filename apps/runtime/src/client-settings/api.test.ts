import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';
import type { FastifyInstance } from 'fastify';

import type { ClientSettingsOutput } from '@isagi/contracts';

import { startRuntimeServer } from '../server.js';

// This exercises the production runtime composition: the endpoint is only usable if the managed
// runtime actually carries RuntimeConfig, which a hand-built single-service runtime cannot prove.
test('client settings endpoint projects normalized runtime settings at the versioned route', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-client-settings-'));
  const previousDataDirectory = process.env.ISAGI_DATA_DIR;
  process.env.ISAGI_DATA_DIR = dataRoot;
  writeFileSync(
    join(dataRoot, 'config.yaml'),
    [
      'terminal:',
      '  scrollbackLines: 12000',
      '  cache:',
      '    idleTtlMinutes: 45',
      '    maxHiddenSessions: 8',
      '    maxEstimatedBufferMiB: 256',
      '',
    ].join('\n'),
    'utf8',
  );
  let server: FastifyInstance | undefined;

  try {
    const started = await Effect.runPromise(startRuntimeServer());
    server = started.server;
    const response = await server.inject({ method: 'GET', url: '/api/v1/client-settings' });
    const payload = response.json() as {
      readonly data?: ClientSettingsOutput & { readonly harnesses?: unknown };
      readonly meta?: { readonly requestId?: string };
    };

    assert.equal(response.statusCode, 200);
    assert.deepEqual(payload.data, {
      terminal: {
        scrollbackLines: 12_000,
        cache: { idleTtlMinutes: 45, maxHiddenSessions: 8, maxEstimatedBufferMiB: 256 },
      },
    });
    assert.equal('harnesses' in (payload.data ?? {}), false);
    assert.equal(typeof payload.meta?.requestId, 'string');
  } finally {
    if (previousDataDirectory === undefined) delete process.env.ISAGI_DATA_DIR;
    else process.env.ISAGI_DATA_DIR = previousDataDirectory;
    await server?.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
