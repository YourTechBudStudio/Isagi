import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { Effect, Layer } from 'effect';

import { DataDirectory } from '../../platform/persistence/index.js';
import { makeTestDataDirectory } from '../../platform/persistence/testing.js';
import { HarnessAdapterRegistry } from '../registry.js';

// The override exactly as the PTY envelope has always spelled it.
const sessionStartOverride = (hookPath: string) =>
  `hooks.SessionStart=[{ matcher = "startup|resume|clear", hooks = [{ type = "command", command = "node '${hookPath}'", timeout = 5, statusMessage = "Recording Codex session" }] }]`;

test('the Codex PTY envelope keeps its exact hook arguments', async () => {
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-codex-pty-args-')));
  try {
    const launch = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* HarnessAdapterRegistry;
        return yield* registry.buildLaunch({
          agentSessionId: 10,
          harness: 'codex',
          cwd: '/repo/isagi',
          latestHarnessSessionId: 'thread-1',
          model: 'gpt-5',
        });
      }).pipe(Effect.provide(registryLayer(dataRoot))),
    );
    const hookPath = resolve(dataRoot, 'harness-integrations/codex/isagi-codex-hook.mjs');
    assert.deepEqual(launch.args, [
      '--enable',
      'hooks',
      '--dangerously-bypass-hook-trust',
      '-c',
      sessionStartOverride(hookPath),
      '--model',
      'gpt-5',
      'resume',
      'thread-1',
    ]);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('Codex SDK instrumentation is the app-server shape the live spike verified', async () => {
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-codex-sdk-')));
  try {
    const sdk = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* HarnessAdapterRegistry;
        return yield* registry.buildSdkInstrumentation({
          agentSessionId: 10,
          harness: 'codex',
          executionId: 'execution-1',
        });
      }).pipe(Effect.provide(registryLayer(dataRoot))),
    );
    const hookPath = resolve(dataRoot, 'harness-integrations/codex/isagi-codex-hook.mjs');
    const directory = resolve(dataRoot, 'sessions', 'agent-sessions', '10');
    assert.deepEqual(sdk, {
      harness: 'codex',
      environment: {
        ISAGI_AGENT_SESSION_ID: '10',
        ISAGI_SDK_EXECUTION_ID: 'execution-1',
        ISAGI_HARNESS_ARTIFACT_DIRECTORY: directory,
        ISAGI_HARNESS_METADATA_PATH: join(directory, 'harness.json'),
      },
      // `codex --dangerously-bypass-hook-trust app-server --listen stdio:// --enable hooks -c …`
      args: {
        beforeSubcommand: ['--dangerously-bypass-hook-trust'],
        appServer: ['--enable', 'hooks', '-c', sessionStartOverride(hookPath)],
      },
      thread: { config: { bypass_hook_trust: true }, sessionStartSource: 'startup' },
    });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

function registryLayer(dataRoot: string) {
  return HarnessAdapterRegistry.layer.pipe(
    Layer.provide(Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot))),
  );
}
