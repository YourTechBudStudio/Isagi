import { Effect, Layer } from 'effect';

import {
  HarnessControlPlane,
  HarnessLaunchBlocked,
  type HarnessControlPlaneService,
  type HarnessLaunchBlockReason,
} from './index.js';
export const allowAllHarnessControlPlane: HarnessControlPlaneService = {
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
