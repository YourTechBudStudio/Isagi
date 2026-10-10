import { Layer } from 'effect';

import { HarnessControlPlane } from './control-plane/service.js';
import { AgentSessionArtifacts } from './ledger.js';
import { HarnessLedgerObserver } from './observer.service.js';
import { HarnessAdapterRegistry } from './registry.js';

/**
 * The harnesses module's public services. Each service's `layer` wires its own module dependencies; the
 * observer's `HarnessObservationTargets` port stays open for the composition root.
 */
export const HarnessesLayer = Layer.mergeAll(
  HarnessControlPlane.layer,
  HarnessLedgerObserver.layer,
  HarnessAdapterRegistry.layer,
  AgentSessionArtifacts.layer,
);
