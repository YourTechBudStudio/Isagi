import { Effect, Layer } from 'effect';

import type { DatabaseError } from '../platform/persistence/index.js';
import {
  HarnessControlPlane,
  HarnessLaunchBlocked,
  type HarnessLaunchBlockReason,
} from './control-plane/service.js';
import { HarnessLedgerObserverInternals, type HarnessLedgerObserver } from './observer.service.js';

/**
 * The observer's poll steps, provided by `HarnessLedgerObserver.layer`/`layerNoDeps` beside the
 * observer itself. Fixture tests drive a poll pass through it instead of waiting for the observer's
 * own interval.
 */
export { HarnessLedgerObserverInternals };

/**
 * Drives one observer poll pass (every live session) or, given an id, that one session's poll step.
 * `observer` names the observer under test; the steps come from the layer that built it.
 */
export function pollHarnessLedgerObserverForTest(
  _observer: HarnessLedgerObserver['Service'],
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
