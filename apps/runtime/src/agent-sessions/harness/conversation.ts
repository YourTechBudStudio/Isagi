import { Effect } from 'effect';

import type { AgentHarness } from '@isagi/contracts';

import { readClaudeConversation } from './claude/conversation.js';
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
    return yield* readConversationHistory({
      agentSessionId,
      streams: sortedHarnessStreams(projection.recordsByHarnessSessionId),
    });
  });
}

function readConversationHistory(input: {
  readonly agentSessionId: number;
  readonly streams: readonly [
    harnessSessionId: string,
    records: readonly HarnessObservationRecord[],
  ][];
}) {
  return Effect.gen(function* () {
    const claudeStreams = input.streams.filter(([, records]) => records[0]?.harness === 'claude');
    if (claudeStreams.length > 0) {
      return yield* readClaudeConversation({
        agentSessionId: input.agentSessionId,
        streams: claudeStreams,
      });
    }

    const messages: ConversationMessage[] = [];
    for (const [, records] of input.streams) {
      const harness = records[0]?.harness;
      if (!harness) continue;
      messages.push(...deriveHarnessConversation(harness, records));
    }
    return messages;
  });
}

export function deriveHarnessConversation(
  harness: AgentHarness,
  records: readonly HarnessObservationRecord[],
): readonly ConversationMessage[] {
  if (harness === 'pi') return derivePiConversation(records);
  if (harness === 'opencode') return deriveOpenCodeConversation(records);
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
