import type { AgentHarness, AttentionState } from '@isagi/contracts';

import { deriveOpenCodeRunningAttention } from './opencode.js';
import { derivePiRunningAttention } from './pi.js';
import type { HarnessObservationRecord } from './projection.js';

export function deriveLastKnownHarnessAttention(
  harness: AgentHarness,
  records: readonly HarnessObservationRecord[],
): AttentionState {
  if (harness === 'pi') return derivePiRunningAttention(records);
  if (harness === 'opencode') return deriveOpenCodeRunningAttention(records);
  return 'idle';
}
