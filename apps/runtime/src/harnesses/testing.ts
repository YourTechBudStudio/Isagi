import { Effect, Layer } from 'effect';

import {
  HarnessControlPlane,
  HarnessLaunchBlocked,
  type HarnessLaunchBlockReason,
} from './control-plane/service.js';

/**
 * The observer's manual poll seam: drives one inventory-and-ledger pass synchronously so fixture
 * tests do not wait on the observer's own poll interval.
 */
export { pollHarnessLedgerObserverForTest } from './observer.service.js';
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
