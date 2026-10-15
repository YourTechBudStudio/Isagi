import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Cause, Effect, Exit, Layer } from 'effect';

import { withApiServer } from '../platform/http/testing.js';
import { DataDirectory } from '../platform/persistence/index.js';
import { makeTestDataDirectory } from '../platform/persistence/testing.js';
import {
  RuntimeConfig,
  RuntimeConfigConflict,
  runtimeConfigError,
  type RuntimeConfigError,
  RuntimeHarnessConfigInvalid,
} from '../runtime-config/index.js';
import { registerHarnessesRoutes } from './api.js';
import { ControlPlaneNotReady, HarnessControlPlane } from './control-plane/service.js';
import type { SdkHarness } from './definitions.js';
import { AgentSessionArtifacts } from './ledger.js';
import { HarnessLedgerObserver } from './observer.service.js';
import { HarnessAdapterRegistry } from './registry.js';

const policyBody = {
  expectedPolicyRevision: 'revision-1',
  policy: {
    pi: { enabled: true, installIsagiDocs: false },
    opencode: { enabled: false, installIsagiDocs: false },
    claude: { enabled: false, installIsagiDocs: false },
    codex: { enabled: false, installIsagiDocs: false },
  },
};

function routesOver(acceptPolicy: HarnessControlPlane['Service']['acceptPolicy']) {
  return Layer.mergeAll(
    Layer.mock(HarnessControlPlane)({ acceptPolicy }),
    Layer.mock(HarnessLedgerObserver)({}),
    Layer.mock(HarnessAdapterRegistry)({
      supportsSdk: (_harness): _harness is SdkHarness => false,
    }),
    Layer.mock(AgentSessionArtifacts)({
      paths: () => ({ directory: '/unused', metadataPath: '/unused/harness.json' }),
    }),
  );
}

async function acceptPolicyFailingWith(
  error:
    | RuntimeConfigConflict
    | RuntimeHarnessConfigInvalid
    | ControlPlaneNotReady
    | RuntimeConfigError,
) {
  return withApiServer(
    routesOver(() => Effect.fail(error)),
    registerHarnessesRoutes,
    async (fastify) => {
      const response = await fastify.inject({
        method: 'PUT',
        url: '/api/v1/control-plane/harness-policy',
        payload: policyBody,
      });
      return { status: response.statusCode, body: response.json() as { error: unknown } };
    },
  );
}

test('accepting a harness policy maps each control-plane failure to its contract error', async () => {
  const conflict = await acceptPolicyFailingWith(
    new RuntimeConfigConflict({ expectedRevision: 'revision-1', actualRevision: 'revision-2' }),
  );
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.body.error, {
    code: 'harness_policy_conflict',
    status: 409,
    message: 'Harness policy changed before this mutation could be applied.',
    requestId: (conflict.body.error as { requestId: string }).requestId,
    data: { expectedPolicyRevision: 'revision-1', actualPolicyRevision: 'revision-2' },
  });

  const invalid = await acceptPolicyFailingWith(
    new RuntimeHarnessConfigInvalid({ diagnostic: 'harnesses.pi must be a string' }),
  );
  assert.equal(invalid.status, 409);
  assert.deepEqual(
    { ...(invalid.body.error as object), requestId: undefined },
    {
      code: 'harness_config_invalid',
      status: 409,
      message: 'Harness configuration is invalid and was left untouched.',
      requestId: undefined,
      data: { diagnostic: 'harnesses.pi must be a string' },
    },
  );

  const notReady = await acceptPolicyFailingWith(
    new ControlPlaneNotReady({ reason: 'inventory_unavailable' }),
  );
  assert.equal(notReady.status, 503);
  assert.deepEqual(
    { ...(notReady.body.error as object), requestId: undefined },
    {
      code: 'control_plane_not_ready',
      status: 503,
      message: 'The harness control plane is not ready to reconcile policy.',
      requestId: undefined,
      data: { reason: 'inventory_unavailable' },
    },
  );

  const unreadable = await acceptPolicyFailingWith(
    runtimeConfigError('/data/config.yaml', { reason: 'read_failed', errno: 'EACCES' }),
  );
  assert.equal(unreadable.status, 500);
  assert.deepEqual(
    { ...(unreadable.body.error as object), requestId: undefined },
    {
      code: 'api_unhandled_error',
      status: 500,
      message: 'config.yaml could not be read (EACCES): /data/config.yaml',
      requestId: undefined,
    },
  );
});

test('a harness-policy config failure reaches the client with its reason and location, never config text', async () => {
  const sentinel = 'sk-isagi-SENTINEL-api';
  const root = mkdtempSync(join(tmpdir(), 'isagi-harness-api-secrets-'));
  try {
    writeFileSync(
      join(root, 'config.yaml'),
      `fluidcast:\n  speech:\n    apiKey: ${sentinel}\n  bad: [${sentinel}\n`,
      'utf8',
    );
    const exit = await Effect.runPromiseExit(
      RuntimeConfig.use((config) => config.get).pipe(
        Effect.provide(RuntimeConfig.layer),
        Effect.provideService(DataDirectory, makeTestDataDirectory(root)),
      ),
    );
    assert.ok(Exit.isFailure(exit));
    const error = Cause.findErrorOption(exit.cause);
    assert.ok(error._tag === 'Some');

    const response = await acceptPolicyFailingWith(error.value);
    const text = JSON.stringify(response.body);
    assert.equal(response.status, 500);
    assert.equal(text.includes(sentinel), false, `the API error leaked the sentinel: ${text}`);
    assert.match(text, /config\.yaml is not valid YAML \([A-Z_]+ at \d+:\d+\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
