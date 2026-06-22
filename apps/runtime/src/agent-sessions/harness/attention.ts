import type { AgentHarness, AttentionState } from '@isagi/contracts';

import { deriveClaudeRunningAttention } from './claude/attention.js';
import { deriveCodexRunningAttention } from './codex/attention.js';
import { deriveOpenCodeRunningAttention } from './opencode/attention.js';
import { derivePiRunningAttention } from './pi/attention.js';
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
