import { Context, Data, Effect, Layer, Ref } from 'effect';

import type {
  AgentHarness,
  ControlPlaneSnapshot,
  DocsReconciliationResult,
  HarnessLaunchBlockReason,
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
import { harnessLaunchDecision } from './launch-decision.js';

// The launch-block reason set is owned by the contract so the wire projection,
// the PTY/HTTP error surfaces, and this enforcement path can never disagree.
export type { HarnessLaunchBlockReason };
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
      start: Effect.gen(function* () {
        yield* inventory.refresh;
        yield* Effect.forkIn(reconcileCurrent(true), scope);
      }),
      snapshot: Effect.gen(function* () {
        const current = yield* config.get;
        const cached = yield* inventory.getCached;
        const rec = yield* Ref.get(reconciliation);
        return snapshotOf(current.harnesses, cached, rec);
      }),
      refreshInventory: refresh,
      acceptPolicy: (input) =>
        Effect.gen(function* () {
          // Prove reconciliation can run before committing: ensure inventory is
          // Ready, refreshing once if it is still pending. If it cannot become
          // Ready, fail BEFORE any config write so policy and revision stay
          // untouched. This keeps the endpoint honest under ADR 0002 — a request
          // failure never leaves a committed policy the caller cannot see.
          let cached = yield* inventory.getCached;
          if (cached._tag === 'Pending') {
            yield* inventory.refresh;
            cached = yield* inventory.getCached;
          }
          if (cached._tag === 'Pending')
            return yield* Effect.fail(
              new ControlPlaneNotReady({ reason: 'inventory_unavailable' }),
            );

          const accepted = yield* config.acceptHarnessPolicy({
            expectedPolicyRevision: input.expectedPolicyRevision,
            policy: input.policy as RuntimeHarnessPolicy,
          });
          // Inventory is Ready and the committed policy is valid, so reconciliation
          // always yields a result. A null here would be a defect, never a
          // post-commit ControlPlaneNotReady that could strand the caller's
          // revision.
          const result = yield* reconcileCurrent(false);
          if (!result)
            return yield* Effect.dieMessage(
              'Docs reconciliation produced no result after committing a valid policy with ready inventory.',
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
          const cached = yield* inventory.getCached;
          const decision = harnessLaunchDecision(current.harnesses, cached, harness);
          if (decision.status === 'blocked')
            return yield* Effect.fail(
              new HarnessLaunchBlocked({
                harness,
                reason: decision.reason,
                diagnostic: decision.diagnostic,
              }),
            );
        }),
    } satisfies HarnessControlPlaneService;
  }),
);
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
    harnesses: supportedHarnesses.map((harness) => {
      const decision = harnessLaunchDecision(policyState, inventory, harness);
      return {
        harness,
        availability:
          inventory._tag === 'Pending'
            ? 'pending'
            : executableAvailability(inventory.inventory.harnesses[harness]),
        policy: policyState.policy[harness],
        launch:
          decision.status === 'launchable'
            ? ({ status: 'launchable' } as const)
            : ({ status: 'blocked', reason: decision.reason } as const),
      };
    }),
    reconciliation: {
      desiredFingerprint: rec.desiredFingerprint,
      runningFingerprint: rec.runningFingerprint,
      lastCompletedFingerprint: rec.lastCompletedFingerprint,
      lastAppliedFingerprint: rec.lastAppliedFingerprint,
      lastResult: rec.lastResult,
    },
  };
}
