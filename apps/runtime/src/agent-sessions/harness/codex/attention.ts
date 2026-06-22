import type { AttentionState } from '@isagi/contracts';

import type { HarnessObservationRecord } from '../projection.js';

export function deriveCodexRunningAttention(
  records: readonly HarnessObservationRecord[],
): AttentionState {
  const latest = latestRelevantCodexRecord(records);
  if (!latest) return 'idle';
  if (latest.nativeEvent === 'UserPromptSubmit') return 'working';
  if (latest.nativeEvent === 'Stop') return 'waiting';
  return 'idle';
}

function latestRelevantCodexRecord(records: readonly HarnessObservationRecord[]) {
  return records
    .filter(
      (record) =>
        record.harness === 'codex' &&
        (record.nativeEvent === 'UserPromptSubmit' || record.nativeEvent === 'Stop'),
    )
    .at(-1);
}
