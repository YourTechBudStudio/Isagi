import type { AgentHarness, HarnessLaunchBlockReason } from '@isagi/contracts';

import type { HostInventoryState } from '../host-inventory/types.js';
import type { RuntimeHarnessPolicyState } from '../runtime-config/index.js';

// The single decision that answers "may Isagi create a process for this harness
// right now, and if not, why?". `assertCanCreateProcess` enforces it (mapping a
// blocked decision into HarnessLaunchBlocked) and the control-plane snapshot
// projects it, so the runtime keeps exactly one copy of this ladder and the web
// never re-derives it. The diagnostic is for the runtime's own error surface;
// the wire projection drops it.
export type HarnessLaunchDecision =
  | { readonly status: 'launchable' }
  | {
      readonly status: 'blocked';
      readonly reason: HarnessLaunchBlockReason;
      readonly diagnostic: string | null;
    };

export function harnessLaunchDecision(
  policy: RuntimeHarnessPolicyState,
  inventory: HostInventoryState,
  harness: AgentHarness,
): HarnessLaunchDecision {
  if (policy.status === 'missing') return blocked('onboarding_incomplete');
  if (policy.status === 'invalid') return blocked('config_invalid', policy.diagnostic);
  if (!policy.policy[harness].enabled) return blocked('harness_disabled');
  if (inventory._tag === 'Pending') return blocked('inventory_pending');
  const availability = inventory.inventory.harnesses[harness];
  switch (availability._tag) {
    case 'Available':
      return { status: 'launchable' };
    case 'Missing':
      return blocked('harness_missing');
    case 'Incompatible':
      return blocked('harness_incompatible');
    case 'ProbeFailed':
      return blocked('harness_probe_failed', availability.diagnostic);
  }
}

function blocked(
  reason: HarnessLaunchBlockReason,
  diagnostic: string | null = null,
): HarnessLaunchDecision {
  return { status: 'blocked', reason, diagnostic };
}
