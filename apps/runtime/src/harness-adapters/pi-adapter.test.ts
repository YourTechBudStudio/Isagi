import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import type { AgentHarness } from '@isagi/contracts';

import type { HarnessEventTokenRegistryService } from '../harness-events/index.js';
import { buildPiLaunch } from './pi-adapter.js';

test('Pi adapter builds a fresh launch envelope with runtime-owned extension injection', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pi-adapter-fresh-'));
  const createdTokens: Array<{
    agentSessionId: number;
    ptyProcessId: number;
    harness: AgentHarness;
  }> = [];
  try {
    const launch = await Effect.runPromise(
      buildPiLaunch(
        {
          agentSessionId: 10,
          harness: 'pi',
          cwd: '/repo/isagi',
          latestHarnessSessionId: null,
        },
        {
          dataRoot,
          eventUrl: 'http://127.0.0.1:17373/internal/harness-events',
          tokens: fakeTokenRegistry(createdTokens),
        },
      ),
    );

    const extensionPath = resolve(dataRoot, 'harness-integrations', 'pi', 'isagi-session.ts');
    assert.equal(launch.command, 'pi');
    assert.deepEqual(launch.args, ['-e', extensionPath]);
    assert.equal(launch.args.includes('--no-extensions'), false);
    assert.equal(launch.cwd, '/repo/isagi');

    const extensionSource = readFileSync(extensionPath, 'utf8');
    assert.match(extensionSource, /session_start/);
    assert.match(extensionSource, /agent_start/);
    assert.match(extensionSource, /turn_start/);
    assert.match(extensionSource, /AbortController/);
    assert.match(extensionSource, /setTimeout\(\(\) => controller\.abort\(\), 1000\)/);
    assert.doesNotMatch(extensionSource, /@earendil-works\/pi-coding-agent/);

    const env = await Effect.runPromise(
      launch.envForProcess?.({ ptyProcessId: 20 }) ?? Effect.succeed({}),
    );
    assert.equal(env.ISAGI_AGENT_SESSION_ID, '10');
    assert.equal(env.ISAGI_HARNESS_EVENT_URL, 'http://127.0.0.1:17373/internal/harness-events');
    assert.equal(env.ISAGI_HARNESS_EVENT_TOKEN, 'token-20');
    assert.deepEqual(createdTokens, [{ agentSessionId: 10, ptyProcessId: 20, harness: 'pi' }]);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('Pi adapter resumes using the latest observed harness session id', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pi-adapter-resume-'));
  try {
    const launch = await Effect.runPromise(
      buildPiLaunch(
        {
          agentSessionId: 10,
          harness: 'pi',
          cwd: '/repo/isagi',
          latestHarnessSessionId: 'pi-session-123',
        },
        {
          dataRoot,
          eventUrl: 'http://127.0.0.1:17373/internal/harness-events',
          tokens: fakeTokenRegistry([]),
        },
      ),
    );

    assert.deepEqual(launch.args, [
      '--session',
      'pi-session-123',
      '-e',
      resolve(dataRoot, 'harness-integrations', 'pi', 'isagi-session.ts'),
    ]);
    assert.equal(launch.args.includes('--no-extensions'), false);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

function fakeTokenRegistry(
  created: Array<{ agentSessionId: number; ptyProcessId: number; harness: AgentHarness }>,
): HarnessEventTokenRegistryService {
  return {
    create: (input) =>
      Effect.sync(() => {
        created.push(input);
        return {
          token: `token-${input.ptyProcessId}`,
          agentSessionId: input.agentSessionId,
          ptyProcessId: input.ptyProcessId,
          harness: input.harness,
          createdAt: '2026-06-16T00:00:00.000Z',
        };
      }),
    resolve: () => Effect.succeed(null),
    revoke: () => Effect.void,
    revokeByPtyProcessId: () => Effect.void,
  } satisfies HarnessEventTokenRegistryService;
}
