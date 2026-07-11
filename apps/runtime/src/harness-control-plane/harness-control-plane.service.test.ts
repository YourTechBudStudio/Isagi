import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { Effect, Layer, Ref } from 'effect';

import { HostInventory, type HostInventoryService } from '../host-inventory/index.js';
import type { ExecutableProbeResult, HostInventoryState } from '../host-inventory/types.js';
import { DataDirectory, type IsagiDataDirectory } from '../persistence/index.js';
import {
  harnessPolicyRevision,
  RuntimeConfig,
  type RuntimeConfigService,
  type RuntimeHarnessPolicy,
  type RuntimeHarnessPolicyState,
} from '../runtime-config/index.js';
import { HarnessControlPlane, HarnessControlPlaneLive, HarnessLaunchBlocked } from './index.js';

const available = { _tag: 'Available', command: 'agent', version: '1.0.0' } as const;
const missing = { _tag: 'Missing', command: 'agent' } as const;
const disabledPolicy: RuntimeHarnessPolicy = {
  pi: { enabled: false, installIsagiDocs: false },
  opencode: { enabled: false, installIsagiDocs: false },
  claude: { enabled: false, installIsagiDocs: false },
  codex: { enabled: false, installIsagiDocs: false },
};

test('launch policy reports each fail-closed state and permits an available enabled harness', async () => {
  const cases: readonly {
    readonly state: RuntimeHarnessPolicyState;
    readonly inventory: HostInventoryState;
    readonly expected: HarnessLaunchBlocked['reason'] | 'allowed';
  }[] = [
    {
      state: policyState('missing', disabledPolicy),
      inventory: { _tag: 'Pending' },
      expected: 'onboarding_incomplete',
    },
    {
      state: policyState('invalid', disabledPolicy),
      inventory: { _tag: 'Pending' },
      expected: 'config_invalid',
    },
    {
      state: policyState('valid', disabledPolicy),
      inventory: ready(available),
      expected: 'harness_disabled',
    },
    {
      state: policyState('valid', enabledPolicy()),
      inventory: { _tag: 'Pending' },
      expected: 'inventory_pending',
    },
    {
      state: policyState('valid', enabledPolicy()),
      inventory: ready(missing),
      expected: 'harness_missing',
    },
    {
      state: policyState('valid', enabledPolicy()),
      inventory: ready({
        _tag: 'Incompatible',
        command: 'agent',
        version: '0.1.0',
        minimumVersion: '1.0.0',
      }),
      expected: 'harness_incompatible',
    },
    {
      state: policyState('valid', enabledPolicy()),
      inventory: ready({
        _tag: 'ProbeFailed',
        command: 'agent',
        reason: 'timeout',
        diagnostic: 'timed out',
      }),
      expected: 'harness_probe_failed',
    },
    {
      state: policyState('valid', enabledPolicy()),
      inventory: ready(available),
      expected: 'allowed',
    },
  ];
  for (const item of cases) {
    const result = await runControlPlane(item.state, item.inventory, (service) =>
      service.assertCanCreateProcess('pi').pipe(Effect.either),
    );
    assert.equal(
      result._tag === 'Right'
        ? 'allowed'
        : result.left instanceof HarnessLaunchBlocked
          ? result.left.reason
          : 'unexpected',
      item.expected,
    );
  }
});

test('an explicit refresh retries a failed desired Docs fingerprint', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-control-plane-retry-'));
  try {
    const policy = enabledPolicy(true);
    const state = policyState('valid', policy);
    const initial = ready(available, 1, true);
    const result = await runControlPlane(
      state,
      initial,
      (service) =>
        Effect.gen(function* () {
          yield* service.refreshInventory;
          const first = yield* service.snapshot;
          yield* service.refreshInventory;
          const second = yield* service.snapshot;
          return { first, second };
        }),
      root,
    );
    assert.equal(result.first.reconciliation.lastResult?.outcome, 'failed');
    assert.equal(result.first.reconciliation.lastResult?.inventoryGeneration, 2);
    assert.equal(result.second.reconciliation.lastResult?.inventoryGeneration, 3);
    assert.equal(result.second.reconciliation.lastAppliedFingerprint, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an identical successful refresh remains current without another reconciliation pass', async () => {
  const state = policyState('valid', enabledPolicy(false));
  const result = await runControlPlane(state, ready(available), (service) =>
    Effect.gen(function* () {
      yield* service.refreshInventory;
      const first = yield* service.snapshot;
      yield* service.refreshInventory;
      const second = yield* service.snapshot;
      return { first, second };
    }),
  );
  assert.equal(result.first.reconciliation.lastResult?.inventoryGeneration, 2);
  assert.equal(
    result.second.inventory.status === 'ready' ? result.second.inventory.generation : 0,
    3,
  );
  assert.equal(result.second.reconciliation.lastResult?.inventoryGeneration, 2);
  assert.equal(
    result.second.reconciliation.lastAppliedFingerprint,
    result.second.reconciliation.desiredFingerprint,
  );
});

function runControlPlane<A>(
  state: RuntimeHarnessPolicyState,
  initialInventory: HostInventoryState,
  use: (service: import('./index.js').HarnessControlPlaneService) => Effect.Effect<A, unknown>,
  root = resolve(tmpdir(), 'isagi-control-plane-test'),
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* HarnessControlPlane;
        return yield* use(service);
      }).pipe(Effect.provide(controlPlaneLayer(state, initialInventory, root))),
    ),
  );
}

function controlPlaneLayer(
  state: RuntimeHarnessPolicyState,
  initialInventory: HostInventoryState,
  root: string,
) {
  const config: RuntimeConfigService = {
    get: Effect.succeed({ pty: { backend: 'node-pty' }, harnesses: state }),
    acceptHarnessPolicy: () => Effect.die('policy mutation is not used'),
  };
  const inventory = Layer.effect(
    HostInventory,
    Effect.gen(function* () {
      const ref = yield* Ref.make(initialInventory);
      const refresh = Ref.update(ref, (current) =>
        current._tag === 'Pending'
          ? ready(available)
          : { ...current, generation: current.generation + 1 },
      );
      return {
        getCached: Ref.get(ref),
        startRefresh: refresh,
        refresh: Effect.zipRight(refresh, Ref.get(ref)).pipe(
          Effect.map((current) => {
            if (current._tag === 'Pending') throw new Error('inventory remained pending');
            return current.inventory;
          }),
        ),
      } satisfies HostInventoryService;
    }),
  );
  return HarnessControlPlaneLive.pipe(
    Layer.provide(inventory),
    Layer.provide(Layer.succeed(RuntimeConfig, config)),
    Layer.provide(Layer.succeed(DataDirectory, { paths: dataPaths(root) })),
  );
}

function policyState(
  status: RuntimeHarnessPolicyState['status'],
  policy: RuntimeHarnessPolicy,
): RuntimeHarnessPolicyState {
  return {
    status,
    onboardingComplete: status === 'valid',
    policy,
    revision: harnessPolicyRevision(status, policy),
    diagnostic: status === 'invalid' ? 'invalid policy' : null,
  };
}

function enabledPolicy(installIsagiDocs = false): RuntimeHarnessPolicy {
  return { ...disabledPolicy, pi: { enabled: true, installIsagiDocs } };
}

function ready(
  pi: ExecutableProbeResult,
  generation = 1,
  environmentFailed = false,
): Extract<HostInventoryState, { readonly _tag: 'Ready' }> {
  return {
    _tag: 'Ready',
    generation,
    refreshedAt: '2026-07-10T00:00:00.000Z',
    inventory: {
      environment: environmentFailed
        ? { _tag: 'ProbeFailed', values: { HOME: '/fallback' }, diagnostic: 'capture failed' }
        : { _tag: 'Available', values: { HOME: '/home/test' } },
      node: available,
      packageManagers: { pnpm: available, npm: missing, bun: missing },
      harnesses: { pi, opencode: missing, claude: missing, codex: missing },
    },
  };
}

function dataPaths(root: string): IsagiDataDirectory {
  return {
    root,
    databasePath: resolve(root, 'isagi.db'),
    statePath: resolve(root, 'state.json'),
    worktreesPath: resolve(root, 'worktrees'),
    sessionsPath: resolve(root, 'sessions'),
    workflowsPath: resolve(root, 'workflows'),
  };
}
