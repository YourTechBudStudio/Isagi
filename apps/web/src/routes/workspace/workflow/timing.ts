import type { WorkflowExecutionSummaryDto } from '@isagi/contracts';

import type { WaitTiming } from '../../../lib/workspace/workflow/history.js';

/** An interval between two recorded instants. `end` is null while it is still open. */
export interface Interval {
  readonly start: number;
  readonly end: number | null;
}

export function parseInstant(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function makeInterval(start: string | null, end: string | null): Interval | null {
  const from = parseInstant(start);
  if (from === null) return null;
  return { start: from, end: parseInstant(end) };
}

/** How long an interval lasted, given the clock for one still open. */
export function intervalDuration(interval: Interval | null, now: number): number | null {
  if (interval === null) return null;
  return Math.max(0, (interval.end ?? now) - interval.start);
}

export function isOpen(interval: Interval | null): boolean {
  return interval !== null && interval.end === null;
}

export interface ExecutionTiming {
  /** The whole execution, start to end. */
  readonly total: Interval | null;
  /** Time until the node function returned, or the whole execution when it never waited. */
  readonly run: Interval | null;
  /** Time the execution spent parked on its wait. */
  readonly wait: Interval | null;
}

/**
 * An execution's intervals.
 *
 * The row records only its start and end; when it started and stopped waiting comes from its
 * `node_waiting` and `wait_delivered` events. A wait with no delivery ends when the execution does
 * (a Cancel, say), and stays open while the execution is still waiting.
 */
export function executionTiming(
  execution: WorkflowExecutionSummaryDto,
  wait: WaitTiming | undefined,
): ExecutionTiming {
  const total = makeInterval(execution.startedAt, execution.endedAt);
  if (wait === undefined) return { total, run: total, wait: null };
  return {
    total,
    run: makeInterval(execution.startedAt, wait.waitingAt),
    wait: makeInterval(wait.waitingAt, wait.deliveredAt ?? execution.endedAt),
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
