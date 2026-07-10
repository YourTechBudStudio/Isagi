import { Effect } from 'effect';

import type { AgentSessionRow } from '../../surfaces/types.js';
import { harnessDefinition } from './definitions.js';
import { HarnessLedgerObserver, type HarnessLedgerObserverService } from './observer.service.js';
import type { HarnessObservationRecord } from './projection.js';
import type { ConversationMessage } from './types.js';

export function getConversationHistory(
  session: Pick<AgentSessionRow, 'id' | 'harness' | 'cwd' | 'harnessSessionId'>,
): Effect.Effect<readonly ConversationMessage[], never, HarnessLedgerObserverService> {
  return Effect.gen(function* () {
    const observer = yield* HarnessLedgerObserver;
    const projection = yield* observer.getProjection(session.id);
    const streams = sortedHarnessStreams(projection?.recordsByHarnessSessionId ?? new Map());
    return yield* harnessDefinition(session.harness).conversation.read({
      agentSessionId: session.id,
      cwd: session.cwd,
      harnessSessionId: session.harnessSessionId,
      streams: targetedHarnessStreams(streams, session.harness, session.harnessSessionId),
    });
  });
}

function targetedHarnessStreams(
  streams: readonly [harnessSessionId: string, records: readonly HarnessObservationRecord[]][],
  harness: AgentSessionRow['harness'],
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
