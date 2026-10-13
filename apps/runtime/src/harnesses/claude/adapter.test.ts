import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { Effect, Layer } from 'effect';

import { DataDirectory } from '../../platform/persistence/index.js';
import { makeTestDataDirectory } from '../../platform/persistence/testing.js';
import { harnessDefinition, supportedHarnesses, type SdkHarness } from '../definitions.js';
import { HarnessAdapterRegistry } from '../registry.js';

test('Claude SDK instrumentation reuses the PTY settings and marks the SDK execution', async () => {
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-claude-sdk-')));
  try {
    const { pty, sdk } = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* HarnessAdapterRegistry;
        const launch = yield* registry.buildLaunch({
          agentSessionId: 10,
          harness: 'claude',
          cwd: '/repo/isagi',
          latestHarnessSessionId: null,
        });
        const ptyEnvironment = yield* launch.envForProcess!({ ptyProcessId: 20 });
        return {
          pty: { args: launch.args, environment: ptyEnvironment },
          sdk: yield* registry.buildSdkInstrumentation({
            agentSessionId: 10,
            harness: 'claude',
            executionId: 'execution-1',
          }),
        };
      }).pipe(Effect.provide(registryLayer(dataRoot))),
    );

    const settingsPath = resolve(dataRoot, 'harness-integrations/claude/settings.json');
    assert.equal(pty.args.at(pty.args.indexOf('--settings') + 1), settingsPath);
    assert.equal(sdk.harness, 'claude');
    assert.equal(sdk.harness === 'claude' && sdk.settingsPath, settingsPath);

    const directory = resolve(dataRoot, 'sessions', 'agent-sessions', '10');
    assert.deepEqual(sdk.environment, {
      ISAGI_AGENT_SESSION_ID: '10',
      ISAGI_SDK_EXECUTION_ID: 'execution-1',
      ISAGI_HARNESS_ARTIFACT_DIRECTORY: directory,
      ISAGI_HARNESS_METADATA_PATH: join(directory, 'harness.json'),
    });
    assert.equal(pty.environment.ISAGI_PTY_PROCESS_ID, '20');
    assert.equal('ISAGI_SDK_EXECUTION_ID' in pty.environment, false);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('SDK support is exactly the harnesses whose definitions declare launch.sdk', async () => {
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-sdk-support-')));
  try {
    const support = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* HarnessAdapterRegistry;
        return supportedHarnesses.map((harness) => [harness, registry.supportsSdk(harness)]);
      }).pipe(Effect.provide(registryLayer(dataRoot))),
    );
    // `SdkHarness` is derived from the same definitions, so `buildSdkInstrumentation` cannot be
    // called for any other harness; this keeps `supportsSdk`'s value in step with that type.
    assert.deepEqual(
      support,
      supportedHarnesses.map((harness) => [
        harness,
        harnessDefinition(harness).launch.sdk !== undefined,
      ]),
    );
    assert.deepEqual(
      support
        .filter(([, supported]) => supported)
        .map(([harness]) => harness)
        .sort(),
      ['claude', 'codex'] satisfies SdkHarness[],
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

function registryLayer(dataRoot: string) {
  return HarnessAdapterRegistry.layer.pipe(
    Layer.provide(Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot))),
  );
}
