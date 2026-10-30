import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ClientSettingsOutput } from '@isagi/contracts';

import { bootRuntime, type BootedRuntime } from './runtime-harness.js';

// This exercises the production runtime composition: the endpoint is only usable if the server's
// runtime actually carries RuntimeConfig, which a hand-built single-service runtime cannot prove.
test('client settings endpoint projects normalized runtime settings at the versioned route', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-client-settings-'));
  writeFileSync(
    join(dataRoot, 'config.yaml'),
    [
      'terminal:',
      '  scrollbackLines: 12000',
      '  cache:',
      '    idleTtlMinutes: 45',
      '    maxHiddenSessions: 8',
      '    maxEstimatedBufferMiB: 256',
      'appearance:',
      '  theme: light',
      '',
    ].join('\n'),
    'utf8',
  );
  let runtime: BootedRuntime | undefined;

  try {
    runtime = await bootRuntime({ dataDirectory: dataRoot });
    const response = await runtime.server.inject({ method: 'GET', url: '/api/v1/client-settings' });
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
      appearance: { theme: 'light' },
    });
    assert.equal('harnesses' in (payload.data ?? {}), false);
    assert.equal(typeof payload.meta?.requestId, 'string');
  } finally {
    await runtime?.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
