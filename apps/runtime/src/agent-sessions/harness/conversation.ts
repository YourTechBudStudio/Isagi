import { Effect } from 'effect';

import type { AgentHarness } from '@isagi/contracts';

import { deriveClaudeConversation } from './claude/conversation.js';
import { deriveCodexConversation } from './codex/conversation.js';
import { HarnessLedgerObserver, type HarnessLedgerObserverService } from './observer.service.js';
import { deriveOpenCodeConversation } from './opencode/conversation.js';
import { derivePiConversation } from './pi/conversation.js';
import type { HarnessObservationRecord } from './projection.js';
import type { ConversationMessage } from './types.js';

export function getConversationHistory(
  agentSessionId: number,
): Effect.Effect<readonly ConversationMessage[], never, HarnessLedgerObserverService> {
  return Effect.gen(function* () {
    const observer = yield* HarnessLedgerObserver;
    const projection = yield* observer.getProjection(agentSessionId);
    if (!projection) return [];
    return sortedHarnessStreams(projection.recordsByHarnessSessionId).flatMap(([, records]) => {
      const harness = records[0]?.harness;
      return harness ? deriveHarnessConversation(harness, records) : [];
    });
  });
}

export function deriveHarnessConversation(
  harness: AgentHarness,
  records: readonly HarnessObservationRecord[],
): readonly ConversationMessage[] {
  if (harness === 'pi') return derivePiConversation(records);
  if (harness === 'opencode') return deriveOpenCodeConversation(records);
  if (harness === 'claude') return deriveClaudeConversation(records);
  if (harness === 'codex') return deriveCodexConversation(records);
  return [];
}

function sortedHarnessStreams(
  recordsByHarnessSessionId: ReadonlyMap<string, readonly HarnessObservationRecord[]>,
) {
  return [...recordsByHarnessSessionId.entries()].sort(([, leftRecords], [, rightRecords]) =>
    earliestRecordedAt(leftRecords).localeCompare(earliestRecordedAt(rightRecords)),
  );
}

function earliestRecordedAt(records: readonly HarnessObservationRecord[]) {
  return records[0]?.recordedAt ?? '';
}
