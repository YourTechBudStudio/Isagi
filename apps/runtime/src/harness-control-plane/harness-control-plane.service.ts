import { Context, Data, Effect, Layer, Ref } from 'effect';

import type {
  AgentHarness,
  ControlPlaneSnapshot,
  DocsReconciliationResult,
  HarnessPolicy,
} from '@isagi/contracts';

import { supportedHarnesses } from '../agent-sessions/harness/definitions.js';
import { HostInventory } from '../host-inventory/index.js';
import { executableAvailability, type HostInventoryState } from '../host-inventory/types.js';
import { DataDirectory } from '../persistence/index.js';
import {
  RuntimeConfig,
  RuntimeConfigConflict,
  RuntimeConfigError,
  RuntimeHarnessConfigInvalid,
  type RuntimeHarnessPolicy,
  type RuntimeHarnessPolicyState,
} from '../runtime-config/index.js';
import { docsReconciliationFingerprint, reconcileDocs } from './docs-reconciler.js';

export type HarnessLaunchBlockReason =
  | 'onboarding_incomplete'
  | 'config_invalid'
  | 'inventory_pending'
  | 'harness_disabled'
  | 'harness_missing'
  | 'harness_incompatible'
  | 'harness_probe_failed';
export class HarnessLaunchBlocked extends Data.TaggedError('HarnessLaunchBlocked')<{
  readonly harness: AgentHarness;
  readonly reason: HarnessLaunchBlockReason;
  readonly diagnostic: string | null;
}> {}
export class ControlPlaneNotReady extends Data.TaggedError('ControlPlaneNotReady')<{
  readonly reason: 'inventory_unavailable';
}> {}
interface ReconciliationState {
  readonly desiredFingerprint: string | null;
  readonly runningFingerprint: string | null;
  readonly lastCompletedFingerprint: string | null;
  readonly lastAppliedFingerprint: string | null;
  readonly lastResult: DocsReconciliationResult | null;
  readonly bootReconciled: boolean;
}
const initialReconciliation: ReconciliationState = {
  desiredFingerprint: null,
  runningFingerprint: null,
  lastCompletedFingerprint: null,
  lastAppliedFingerprint: null,
  lastResult: null,
  bootReconciled: false,
};
export interface HarnessControlPlaneService {
  readonly start: Effect.Effect<void>;
  readonly snapshot: Effect.Effect<ControlPlaneSnapshot>;
  readonly refreshInventory: Effect.Effect<{ readonly generation: number }>;
  readonly acceptPolicy: (input: {
    readonly expectedPolicyRevision: string;
    readonly policy: HarnessPolicy;
  }) => Effect.Effect<
    {
      readonly acceptedPolicyRevision: string;
      readonly reconciledPolicyRevision: string;
      readonly inventoryGeneration: number;
      readonly disposition: 'applied' | 'superseded';
      readonly reconciliation: DocsReconciliationResult;
    },
    RuntimeConfigError | RuntimeConfigConflict | RuntimeHarnessConfigInvalid | ControlPlaneNotReady
  >;
  readonly assertCanCreateProcess: (
    harness: AgentHarness,
  ) => Effect.Effect<void, HarnessLaunchBlocked>;
}
export const HarnessControlPlane = Context.GenericTag<HarnessControlPlaneService>(
  'isagi/HarnessControlPlane',
);
export const HarnessControlPlaneLive = Layer.scoped(
  HarnessControlPlane,
  Effect.gen(function* () {
    const inventory = yield* HostInventory;
    const config = yield* RuntimeConfig;
    const directory = yield* DataDirectory;
    const scope = yield* Effect.scope;
    const reconciliation = yield* Ref.make(initialReconciliation);
    const lock = yield* Effect.makeSemaphore(1);
    const reconcileCurrent = (forceBoot: boolean) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const inventoryState = yield* inventory.getCached;
          if (inventoryState._tag === 'Pending') return null;
          const current = yield* config.get;
          if (current.harnesses.status === 'invalid') return null;
          const input = {
            dataRoot: directory.paths.root,
            policy: current.harnesses.policy,
            policyRevision: current.harnesses.revision,
            inventoryGeneration: inventoryState.generation,
            inventory: inventoryState.inventory,
          };
          const fingerprint = docsReconciliationFingerprint(input);
          const state = yield* Ref.get(reconciliation);
          yield* Ref.set(reconciliation, { ...state, desiredFingerprint: fingerprint });
          if (!forceBoot && state.bootReconciled && state.lastAppliedFingerprint === fingerprint)
            return state.lastResult;
          yield* Ref.update(reconciliation, (value) => ({
            ...value,
            runningFingerprint: fingerprint,
          }));
          const result = yield* reconcileDocs(input);
          yield* Ref.update(reconciliation, (value) => ({
            ...value,
            runningFingerprint: null,
            lastCompletedFingerprint: fingerprint,
            lastAppliedFingerprint:
              result.outcome === 'succeeded' ? fingerprint : value.lastAppliedFingerprint,
            lastResult: result,
            bootReconciled: true,
          }));
          return result;
        }),
      );
    const refresh = Effect.gen(function* () {
      yield* inventory.refresh;
      const cached = yield* inventory.getCached;
      if (cached._tag === 'Pending')
        return yield* Effect.die('Inventory remained pending after refresh.');
      yield* reconcileCurrent(false);
      return { generation: cached.generation };
    });
    return {
      start: Effect.asVoid(
        Effect.forkIn(
          Effect.gen(function* () {
            yield* inventory.refresh;
            yield* reconcileCurrent(true);
          }),
          scope,
        ),
      ),
      snapshot: Effect.gen(function* () {
        const current = yield* config.get;
        const cached = yield* inventory.getCached;
        const rec = yield* Ref.get(reconciliation);
        return snapshotOf(current.harnesses, cached, rec);
      }),
      refreshInventory: refresh,
      acceptPolicy: (input) =>
        Effect.gen(function* () {
          const accepted = yield* config.acceptHarnessPolicy({
            expectedPolicyRevision: input.expectedPolicyRevision,
            policy: input.policy as RuntimeHarnessPolicy,
          });
          let result = yield* reconcileCurrent(false);
          if (!result) {
            yield* inventory.refresh;
            result = yield* reconcileCurrent(false);
          }
          if (!result)
            return yield* Effect.fail(
              new ControlPlaneNotReady({ reason: 'inventory_unavailable' }),
            );
          return {
            acceptedPolicyRevision: accepted.harnesses.revision,
            reconciledPolicyRevision: result.policyRevision,
            inventoryGeneration: result.inventoryGeneration,
            disposition:
              accepted.harnesses.revision === result.policyRevision ? 'applied' : 'superseded',
            reconciliation: result,
          };
        }),
      assertCanCreateProcess: (harness) =>
        Effect.gen(function* () {
          const current = yield* config.get;
          if (current.harnesses.status === 'missing')
            return yield* blocked(harness, 'onboarding_incomplete');
          if (current.harnesses.status === 'invalid')
            return yield* blocked(harness, 'config_invalid', current.harnesses.diagnostic);
          if (!current.harnesses.policy[harness].enabled)
            return yield* blocked(harness, 'harness_disabled');
          const cached = yield* inventory.getCached;
          if (cached._tag === 'Pending') return yield* blocked(harness, 'inventory_pending');
          const availability = cached.inventory.harnesses[harness];
          if (availability._tag === 'Available') return;
          if (availability._tag === 'Missing') return yield* blocked(harness, 'harness_missing');
          if (availability._tag === 'Incompatible')
            return yield* blocked(harness, 'harness_incompatible');
          return yield* blocked(harness, 'harness_probe_failed', availability.diagnostic);
        }),
    } satisfies HarnessControlPlaneService;
  }),
);
function blocked(
  harness: AgentHarness,
  reason: HarnessLaunchBlockReason,
  diagnostic: string | null = null,
) {
  return Effect.fail(new HarnessLaunchBlocked({ harness, reason, diagnostic }));
}
function snapshotOf(
  policyState: RuntimeHarnessPolicyState,
  inventory: HostInventoryState,
  rec: ReconciliationState,
): ControlPlaneSnapshot {
  return {
    onboardingComplete: policyState.onboardingComplete,
    configStatus: policyState.status,
    configDiagnostic: policyState.diagnostic,
    policyRevision: policyState.revision,
    inventory:
      inventory._tag === 'Pending'
        ? { status: 'pending' }
        : {
            status: 'ready',
            generation: inventory.generation,
            environment:
              inventory.inventory.environment._tag === 'Available' ? 'trusted' : 'probe_failed',
            node: executableAvailability(inventory.inventory.node),
            packageManagers: {
              pnpm: executableAvailability(inventory.inventory.packageManagers.pnpm),
              npm: executableAvailability(inventory.inventory.packageManagers.npm),
              bun: executableAvailability(inventory.inventory.packageManagers.bun),
            },
          },
    harnesses: supportedHarnesses.map((harness) => ({
      harness,
      availability:
        inventory._tag === 'Pending'
          ? 'pending'
          : executableAvailability(inventory.inventory.harnesses[harness]),
      policy: policyState.policy[harness],
    })),
    reconciliation: {
      desiredFingerprint: rec.desiredFingerprint,
      runningFingerprint: rec.runningFingerprint,
      lastCompletedFingerprint: rec.lastCompletedFingerprint,
      lastAppliedFingerprint: rec.lastAppliedFingerprint,
      lastResult: rec.lastResult,
    },
  };
}
