import type { ExecutionInterval, Incarnation } from '../incarnation.js';
import type { CodexRolloutLifecycleRecord, CodexRolloutRecord } from './lifecycle.js';

/** One `SessionStart` hook record of a Codex thread: the execution that started or resumed it. */
export interface SessionStartBoundary {
  readonly incarnation: Incarnation | null;
  readonly recordedAt: string;
}

/**
 * Attributes one Codex thread's rollout records to the execution that wrote them.
 *
 * Rollout files carry no Isagi marker, so a record's execution is inferred from its own timestamp:
 * - inside an execution interval, it belongs to that interval's execution only when that execution
 *   already wrote a `SessionStart` for the thread, and is otherwise unattributed (`null`);
 * - before the first interval (history older than this runtime process), it belongs to the latest
 *   preceding `SessionStart`, an execution that has necessarily ended;
 * - without a timestamp, it is unattributed.
 *
 * The result depends only on the record, the hook boundaries and the intervals, which later
 * switches extend but never rewrite, so it does not change as the agent moves between executions.
 * `null` means unknown provenance: never current, never failed as dead.
 *
 * `intervals` are the agent's, ordered by `since`. All times come from one machine clock.
 */
export function attributeCodexRecords(input: {
  readonly records: ReadonlyArray<CodexRolloutRecord>;
  readonly sessionStarts: ReadonlyArray<SessionStartBoundary>;
  readonly intervals: ReadonlyArray<ExecutionInterval>;
}): ReadonlyArray<CodexRolloutLifecycleRecord> {
  const boundaries = input.sessionStarts
    .map((boundary) => ({ incarnation: boundary.incarnation, at: Date.parse(boundary.recordedAt) }))
    .filter((boundary) => !Number.isNaN(boundary.at));
  const intervals = input.intervals.map((interval) => ({
    incarnation: interval.incarnation,
    since: Date.parse(interval.since),
  }));
  const firstSince = intervals[0]?.since;

  const attribute = (recordedAt: string): Incarnation | null => {
    const at = Date.parse(recordedAt);
    if (Number.isNaN(at)) return null;
    if (firstSince === undefined || at < firstSince) {
      let latest: { readonly incarnation: Incarnation | null; readonly at: number } | null = null;
      for (const boundary of boundaries) {
        if (boundary.at <= at && (latest === null || boundary.at >= latest.at)) latest = boundary;
      }
      return latest?.incarnation ?? null;
    }
    const interval = intervals.findLast((candidate) => candidate.since <= at);
    const incarnation = interval?.incarnation ?? null;
    if (incarnation === null) return null;
    return boundaries.some((boundary) => boundary.incarnation === incarnation && boundary.at <= at)
      ? incarnation
      : null;
  };

  return input.records.map((record) => ({ ...record, incarnation: attribute(record.recordedAt) }));
}
