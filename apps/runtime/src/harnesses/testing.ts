import { Effect, Layer } from 'effect';

import type { DatabaseError } from '../platform/persistence/index.js';
import {
  HarnessControlPlane,
  HarnessLaunchBlocked,
  type HarnessLaunchBlockReason,
} from './control-plane/service.js';
import {
  HarnessLedgerObserverInternals,
  makeHarnessLedgerObserverContext,
} from './observer.service.js';

/**
 * The observer's poll steps. Fixture tests drive a poll pass through it instead of waiting for the
 * observer's own interval; `HarnessLedgerObserverWithInternalsLayerNoDeps` provides it.
 */
export { HarnessLedgerObserverInternals };

/** For fakes of `AgentSessionArtifacts` that fail a write the way the real one does. */
export { AgentSessionArtifactError } from './ledger.js';

/**
 * `HarnessLedgerObserver.layerNoDeps` plus the observer's poll steps (`HarnessLedgerObserverInternals`),
 * built from the same instance. Test-only: the production layers provide the observer alone, so the
 * seam stays out of the runtime's service graph.
 */
export const HarnessLedgerObserverWithInternalsLayerNoDeps = Layer.effectContext(
  makeHarnessLedgerObserverContext,
);

/**
 * Drives one observer poll pass (every live session) or, given an id, that one session's poll step.
 * The steps come from the `HarnessLedgerObserverInternals` in context, which
 * `HarnessLedgerObserverWithInternalsLayerNoDeps` provides beside the observer under test.
 */
export function pollHarnessLedgerObserverForTest(
  agentSessionId?: number,
): Effect.Effect<void, DatabaseError, HarnessLedgerObserverInternals> {
  return Effect.flatMap(HarnessLedgerObserverInternals, (internals) =>
    agentSessionId === undefined ? internals.pollOnce : internals.pollAgentSession(agentSessionId),
  );
}

export const allowAllHarnessControlPlane: HarnessControlPlane['Service'] = {
  start: Effect.void,
  snapshot: Effect.die('snapshot is not used'),
  refreshInventory: Effect.die('refreshInventory is not used'),
  acceptPolicy: () => Effect.die('acceptPolicy is not used'),
  assertCanCreateProcess: () => Effect.void,
};
export const AllowAllHarnessControlPlaneLayer = Layer.succeed(
  HarnessControlPlane,
  allowAllHarnessControlPlane,
);

export function blockedHarnessControlPlaneLayer(reason: HarnessLaunchBlockReason) {
  return Layer.succeed(HarnessControlPlane, {
    ...allowAllHarnessControlPlane,
    assertCanCreateProcess: (harness) =>
      Effect.fail(new HarnessLaunchBlocked({ harness, reason, diagnostic: null })),
  });
}

// Internals and builders other modules' tests use; never imported by production code.
export {
  configSchemaReferenceSources,
  isagiDocsContentSources,
  isagiDocsName,
  isagiDocsPackageFiles,
  workflowScaffoldSources,
} from './isagi-docs.js';
