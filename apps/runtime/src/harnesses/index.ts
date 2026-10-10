export { HarnessAdapterRegistry } from './registry.js';
export { HarnessLedgerObserver, HarnessObserverRefreshError } from './observer.service.js';
export type { ObservedHarnessTurnEdge } from './observer.service.js';
export { getConversationHistory, type ConversationSession } from './conversation.js';
export { HarnessObservationTargets, type HarnessObservationTarget } from './observation-targets.js';
export type { HarnessTurnEdge } from './lifecycle.js';
export { displayNameForHarness } from './display.js';
export {
  HarnessAdapterError,
  type ConversationMessage,
  type ConversationPart,
  type ConversationRole,
  type HarnessAdapter,
  type HarnessLaunchContext,
} from './types.js';
export { registerControlPlaneApi } from './api.js';
export { HarnessControlPlane, HarnessLaunchBlocked } from './control-plane/service.js';
export type { HarnessConversationTurn } from './definition-types.js';
export { harnessDefinition } from './definitions.js';
export { AgentSessionArtifacts } from './ledger.js';
export type { AgentSessionHarnessMetadataRead } from './ledger.js';
export type { HarnessLaunchOptions } from './types.js';

// Composition-root wiring only: `app/layer.ts` still provides these by hand until the services wire
// their own module dependencies (S3.7). No other module imports them.
export { HostInventory } from './inventory/service.js';
