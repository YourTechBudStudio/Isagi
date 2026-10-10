import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Layer } from 'effect';

import { withApiServer } from '../platform/http/testing.js';
import {
  RuntimeConfigConflict,
  RuntimeConfigError,
  RuntimeHarnessConfigInvalid,
} from '../runtime-config/index.js';
import { registerHarnessesRoutes } from './api.js';
import { ControlPlaneNotReady, HarnessControlPlane } from './control-plane/service.js';
import { AgentSessionArtifacts } from './ledger.js';
import { HarnessLedgerObserver, HarnessLedgerObserverInternals } from './observer.service.js';
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
    Layer.mock(HarnessLedgerObserverInternals)({}),
    Layer.mock(HarnessAdapterRegistry)({}),
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
    new RuntimeConfigError({ path: '/data/config.yaml', cause: new Error('EACCES') }),
  );
  assert.equal(unreadable.status, 500);
  assert.deepEqual(
    { ...(unreadable.body.error as object), requestId: undefined },
    {
      code: 'api_unhandled_error',
      status: 500,
      message: 'Unhandled runtime error',
      requestId: undefined,
    },
  );
});
