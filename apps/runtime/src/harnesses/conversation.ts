import { Effect } from 'effect';

import type { AgentHarness } from '@isagi/contracts';

import type { HarnessConversationTurn } from './definition-types.js';
import { harnessDefinition } from './definitions.js';
import { HarnessLedgerObserver } from './observer.service.js';
import type { HarnessObservationRecord } from './projection.js';
import type { ConversationMessage } from './types.js';

/** The agent session facts a conversation read needs; the environment's session row satisfies it. */
export interface ConversationSession {
  readonly id: number;
  readonly harness: AgentHarness;
  readonly cwd: string;
  readonly harnessSessionId: string | null;
}

export function getConversationHistory(
  session: ConversationSession,
  turn?: HarnessConversationTurn,
): Effect.Effect<readonly ConversationMessage[], never, HarnessLedgerObserver> {
  return Effect.gen(function* () {
    const observer = yield* HarnessLedgerObserver;
    const projection = yield* observer.getProjection(session.id);
    const streams = sortedHarnessStreams(projection?.recordsByHarnessSessionId ?? new Map());
    return yield* harnessDefinition(session.harness).conversation.read({
      agentSessionId: session.id,
      cwd: session.cwd,
      harnessSessionId: turn?.harnessSessionId ?? session.harnessSessionId,
      streams: targetedHarnessStreams(
        streams,
        session.harness,
        turn?.harnessSessionId ?? session.harnessSessionId,
      ),
      turn,
    });
  });
}

function targetedHarnessStreams(
  streams: readonly [harnessSessionId: string, records: readonly HarnessObservationRecord[]][],
  harness: AgentHarness,
  harnessSessionId: string | null,
) {
  return streams.filter(([streamHarnessSessionId, records]) => {
    if (records[0]?.harness !== harness) return false;
    return harnessSessionId ? streamHarnessSessionId === harnessSessionId : true;
  });
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
