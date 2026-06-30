import { Effect } from 'effect';

import type { AgentSessionRow } from '../../surfaces/types.js';
import { readClaudeConversation } from './claude/conversation.js';
import { readCodexConversation } from './codex/conversation.js';
import { HarnessLedgerObserver, type HarnessLedgerObserverService } from './observer.service.js';
import { readOpenCodeConversation } from './opencode/conversation.js';
import { readPiConversation } from './pi/conversation.js';
import type { HarnessObservationRecord } from './projection.js';
import type { ConversationMessage } from './types.js';

export function getConversationHistory(
  session: Pick<AgentSessionRow, 'id' | 'harness' | 'cwd' | 'harnessSessionId'>,
): Effect.Effect<readonly ConversationMessage[], never, HarnessLedgerObserverService> {
  return Effect.gen(function* () {
    const observer = yield* HarnessLedgerObserver;
    const projection = yield* observer.getProjection(session.id);
    const streams = sortedHarnessStreams(projection?.recordsByHarnessSessionId ?? new Map());
    if (session.harness === 'claude') {
      const claudeStreams = targetedHarnessStreams(
        streams,
        session.harness,
        session.harnessSessionId,
      );
      return yield* readClaudeConversation({
        agentSessionId: session.id,
        cwd: session.cwd,
        harnessSessionId: session.harnessSessionId,
        streams: claudeStreams,
      });
    }
    if (session.harness === 'codex') {
      const codexStreams = targetedHarnessStreams(
        streams,
        session.harness,
        session.harnessSessionId,
      );
      return yield* readCodexConversation({
        agentSessionId: session.id,
        cwd: session.cwd,
        harnessSessionId: session.harnessSessionId,
        streams: codexStreams,
      });
    }
    if (session.harness === 'pi') {
      const piStreams = targetedHarnessStreams(streams, session.harness, session.harnessSessionId);
      return yield* readPiConversation({
        agentSessionId: session.id,
        cwd: session.cwd,
        harnessSessionId: session.harnessSessionId,
        streams: piStreams,
      });
    }
    if (session.harness === 'opencode') {
      const openCodeStreams = targetedHarnessStreams(
        streams,
        session.harness,
        session.harnessSessionId,
      );
      return yield* readOpenCodeConversation({
        agentSessionId: session.id,
        cwd: session.cwd,
        harnessSessionId: session.harnessSessionId,
        streams: openCodeStreams,
      });
    }
    return yield* readConversationHistory({
      agentSessionId: session.id,
      streams,
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
    const codexStreams = input.streams.filter(([, records]) => records[0]?.harness === 'codex');
    if (codexStreams.length > 0) {
      return yield* readCodexConversation({
        agentSessionId: input.agentSessionId,
        streams: codexStreams,
      });
    }
    const openCodeStreams = input.streams.filter(
      ([, records]) => records[0]?.harness === 'opencode',
    );
    if (openCodeStreams.length > 0) {
      return yield* readOpenCodeConversation({
        agentSessionId: input.agentSessionId,
        streams: openCodeStreams,
      });
    }

    return [];
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
