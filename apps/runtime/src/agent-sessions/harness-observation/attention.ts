import type { AgentHarness, AttentionState } from '@isagi/contracts';

import { deriveClaudeRunningAttention } from './claude.js';
import { deriveCodexRunningAttention } from './codex.js';
import { deriveOpenCodeRunningAttention } from './opencode.js';
import { derivePiRunningAttention } from './pi.js';
import type { HarnessObservationRecord } from './projection.js';

export function deriveLastKnownHarnessAttention(
  harness: AgentHarness,
  records: readonly HarnessObservationRecord[],
): AttentionState {
  if (harness === 'pi') return derivePiRunningAttention(records);
  if (harness === 'opencode') return deriveOpenCodeRunningAttention(records);
  if (harness === 'claude') return deriveClaudeRunningAttention(records);
  if (harness === 'codex') return deriveCodexRunningAttention(records);
  return 'idle';
}
