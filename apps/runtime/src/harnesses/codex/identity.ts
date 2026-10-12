import type { HarnessObservationRecord } from '../projection.js';

export interface CodexStreamCandidate {
  readonly harnessSessionId: string;
  readonly lastStartedAt: string;
  readonly lastStartedSeq: number;
}

export function activeCodexStreamCandidates(
  streams: ReadonlyMap<string, readonly HarnessObservationRecord[]>,
  activePtyProcessId: number | null,
): readonly CodexStreamCandidate[] {
  if (activePtyProcessId === null) return [];
  const candidates: CodexStreamCandidate[] = [];
  for (const [harnessSessionId, records] of streams) {
    const starts = records.filter(
      (record) =>
        record.harness === 'codex' &&
        record.nativeEvent === 'SessionStart' &&
        record.ptyProcessId === activePtyProcessId,
    );
    const latest = starts.toSorted(compareStartRecords).at(-1);
    if (!latest) continue;
    candidates.push({
      harnessSessionId,
      lastStartedAt: latest.recordedAt,
      lastStartedSeq: latest.seq,
    });
  }
  return candidates.toSorted(compareCandidates);
}

export function selectConfirmedCodexPrimary(input: {
  readonly candidates: readonly CodexStreamCandidate[];
  readonly confirmedHarnessSessionIds: ReadonlySet<string>;
  readonly currentHarnessSessionId: string | null;
}) {
  const latestConfirmed = input.candidates
    .filter((candidate) => input.confirmedHarnessSessionIds.has(candidate.harnessSessionId))
    .at(-1);
  if (latestConfirmed) return latestConfirmed.harnessSessionId;
  if (
    input.currentHarnessSessionId &&
    input.confirmedHarnessSessionIds.has(input.currentHarnessSessionId)
  ) {
    return input.currentHarnessSessionId;
  }
  return null;
}

function compareStartRecords(left: HarnessObservationRecord, right: HarnessObservationRecord) {
  return left.recordedAt.localeCompare(right.recordedAt) || left.seq - right.seq;
}

function compareCandidates(left: CodexStreamCandidate, right: CodexStreamCandidate) {
  return (
    left.lastStartedAt.localeCompare(right.lastStartedAt) ||
    left.lastStartedSeq - right.lastStartedSeq ||
    left.harnessSessionId.localeCompare(right.harnessSessionId)
  );
}
