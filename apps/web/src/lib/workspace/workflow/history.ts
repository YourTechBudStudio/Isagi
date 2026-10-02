import type { WorkflowEventDto } from '@isagi/contracts';

/**
 * Facts that live only in a run's event log, derived for the Trace.
 *
 * No row carries a pause, a code reload or when a wait was delivered, so these are read from the
 * events the runtime appended when they happened. Everything here is a pure function of the event
 * list, so it is simply recomputed when an event arrives.
 */

export interface PauseBand {
  readonly start: string;
  /** Null while the run is still paused. */
  readonly end: string | null;
}

/** Pauses, from each `run_paused` to the `run_resumed` or `run_cancelled` that ended it. */
export function pauseBands(events: readonly WorkflowEventDto[]): readonly PauseBand[] {
  const bands: PauseBand[] = [];
  let open: string | null = null;
  for (const event of events) {
    if (event.kind === 'run_paused' && open === null) open = event.at;
    else if ((event.kind === 'run_resumed' || event.kind === 'run_cancelled') && open !== null) {
      bands.push({ start: open, end: event.at });
      open = null;
    }
  }
  if (open !== null) bands.push({ start: open, end: null });
  return bands;
}

export interface CodeReload {
  readonly eventId: number;
  readonly at: string;
  readonly from: string | null;
  readonly to: string | null;
}

/** Each time Resume or Retry moved the run onto a newer verified build. */
export function codeReloads(events: readonly WorkflowEventDto[]): readonly CodeReload[] {
  const reloads: CodeReload[] = [];
  for (const event of events) {
    if (event.kind !== 'code_reloaded') continue;
    const data = asRecord(event.data);
    reloads.push({
      eventId: event.eventId,
      at: event.at,
      from: typeof data?.['from'] === 'string' ? data['from'] : null,
      to: typeof data?.['to'] === 'string' ? data['to'] : null,
    });
  }
  return reloads;
}

export interface Retry {
  readonly eventId: number;
  readonly at: string;
  /** The new execution. Null when the Retry restarted the run's preparation. */
  readonly executionId: number | null;
  readonly message: string;
}

/** Each accepted Retry, in order. */
export function retries(events: readonly WorkflowEventDto[]): readonly Retry[] {
  return events
    .filter((event) => event.kind === 'run_retried')
    .map((event) => ({
      eventId: event.eventId,
      at: event.at,
      executionId: event.executionId,
      message: event.message,
    }));
}

export interface WaitTiming {
  /** When the node parked on its wait. */
  readonly waitingAt: string;
  /** When the wait was answered. Null while the node is still waiting. */
  readonly deliveredAt: string | null;
}

/**
 * When each execution started and stopped waiting.
 *
 * An execution's own row has only its start and end, so the split between "the node function ran"
 * and "it waited" comes from its `node_waiting` and `wait_delivered` events.
 */
export function waitTimings(events: readonly WorkflowEventDto[]): ReadonlyMap<number, WaitTiming> {
  const timings = new Map<number, WaitTiming>();
  for (const event of events) {
    if (event.executionId === null) continue;
    if (event.kind === 'node_waiting' && !timings.has(event.executionId)) {
      timings.set(event.executionId, { waitingAt: event.at, deliveredAt: null });
    } else if (event.kind === 'wait_delivered') {
      const timing = timings.get(event.executionId);
      if (timing && timing.deliveredAt === null) {
        timings.set(event.executionId, { ...timing, deliveredAt: event.at });
      }
    }
  }
  return timings;
}

/** An execution's own events, in order: what the dock lists as its history. */
export function executionEvents(
  events: readonly WorkflowEventDto[],
  executionId: number,
): readonly WorkflowEventDto[] {
  return events.filter((event) => event.executionId === executionId);
}

/**
 * The run's own and its environment's events, for the Trace's run lane. Chosen by category alone:
 * a Retry or a failure names the execution it is about, and is still a run event.
 */
export function runEvents(events: readonly WorkflowEventDto[]): readonly WorkflowEventDto[] {
  return events.filter((event) => event.category === 'run' || event.category === 'environment');
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}
