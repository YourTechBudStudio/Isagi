import type { WorkflowExecutionDto } from '@isagi/contracts';

/**
 * Intervals, and the difference between "still running" and "nobody knows when it ended".
 *
 * An interval whose owner was interrupted has `endCertainty: 'unknown'`. Stretching it to the
 * current clock would invent an observed duration for something nobody observed, so an unknown end
 * yields no duration at all — the caller renders it as unknown rather than as a number.
 */

export type IntervalEnd =
  | { readonly kind: 'ended'; readonly at: number }
  | { readonly kind: 'open' }
  | { readonly kind: 'unknown' };

export interface Interval {
  readonly start: number;
  readonly end: IntervalEnd;
}

export function parseInstant(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function makeInterval(
  start: string | null,
  end: string | null,
  certainty: 'observed' | 'unknown' = 'observed',
): Interval | null {
  const from = parseInstant(start);
  if (from === null) return null;
  const to = parseInstant(end);
  if (to !== null) return { start: from, end: { kind: 'ended', at: to } };
  return { start: from, end: { kind: certainty === 'unknown' ? 'unknown' : 'open' } };
}

/**
 * How long an interval lasted, given the clock.
 *
 * `null` means no honest number exists: an unknown end has none, and the caller must say so rather
 * than print an elapsed time that would look like a measurement.
 */
export function intervalDuration(interval: Interval | null, now: number): number | null {
  if (interval === null) return null;
  switch (interval.end.kind) {
    case 'ended':
      return Math.max(0, interval.end.at - interval.start);
    case 'open':
      return Math.max(0, now - interval.start);
    case 'unknown':
      return null;
  }
}

export function isOpen(interval: Interval | null): boolean {
  return interval?.end.kind === 'open';
}

export interface ExecutionTiming {
  /** The whole visit, start to end. */
  readonly total: Interval | null;
  /** Time inside the author's callback. */
  readonly callback: Interval | null;
  /** Time the visit spent armed on a wait. Overlaps nothing; it follows the callback. */
  readonly wait: Interval | null;
}

/**
 * A visit's intervals, each carrying the certainty that actually applies to it.
 *
 * `endCertainty` is a fact about the attempt's *owner*: unknown means the process that would have
 * recorded the end is gone. An unterminated callback under that certainty therefore has an unknown
 * end, not an open one — treating it as open would grow an invented duration for as long as the
 * inspector stayed open, on the very run where nobody knows what happened.
 *
 * A wait is the exception, and only because it is durable. `wait.status === 'armed'` is a recorded
 * fact that survives a restart, so a wait the run says is armed is genuinely still open however its
 * execution ended. Without that record, the execution's certainty governs.
 */
export function executionTiming(execution: WorkflowExecutionDto): ExecutionTiming {
  const waitStillArmed = execution.wait?.status === 'armed';
  return {
    total: makeInterval(execution.startedAt, execution.endedAt, execution.endCertainty),
    callback: makeInterval(
      execution.callbackStartedAt,
      execution.callbackEndedAt,
      execution.endCertainty,
    ),
    wait: makeInterval(
      execution.waitArmedAt,
      execution.waitDeliveredAt,
      waitStillArmed ? 'observed' : execution.endCertainty,
    ),
  };
}

/** Formats a duration the way the bar and the inspector both say it. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

/** Wall-clock time of day, for a recorded instant. */
export function formatClock(value: string | null): string {
  const at = parseInstant(value);
  if (at === null) return '—';
  return new Date(at).toLocaleTimeString(undefined, { hour12: false });
}
