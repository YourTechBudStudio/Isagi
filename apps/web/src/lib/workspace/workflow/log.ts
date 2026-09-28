import type { WorkflowEventDto } from '@isagi/contracts';

import { workflowCopy } from '../../../copy/index.js';

export type WorkflowLogTone = 'debug' | 'info' | 'warning' | 'error';

/**
 * One line of the bar's log: an author's `log` call or `setUiFeedback`, or a runtime warning such
 * as an agent reply that could not be read.
 *
 * `body` is always something honest to show. A line whose data does not have the expected shape
 * falls back to the event's own message rather than rendering an empty line.
 */
export interface WorkflowLogLine {
  readonly eventId: number;
  readonly at: string;
  readonly tone: WorkflowLogTone;
  readonly label: 'log' | 'feedback';
  readonly body: string;
}

/** The run's log lines, read from its event list. */
export function workflowLogLines(events: readonly WorkflowEventDto[]): readonly WorkflowLogLine[] {
  const lines: WorkflowLogLine[] = [];
  for (const event of events) {
    const line = workflowLogLine(event);
    if (line !== null) lines.push(line);
  }
  return lines;
}

export function workflowLogLine(event: WorkflowEventDto): WorkflowLogLine | null {
  if (event.kind === 'log') {
    const data = asRecord(event.data);
    const level = data?.['level'];
    const message = data?.['message'];
    return {
      eventId: event.eventId,
      at: event.at,
      tone: isTone(level) ? level : 'info',
      label: 'log',
      body: typeof message === 'string' ? message : event.message,
    };
  }
  if (event.kind === 'ui_feedback') {
    const data = asRecord(event.data);
    const kind = data?.['kind'];
    const message = data?.['message'];
    const phase = data?.['phase'];
    return {
      eventId: event.eventId,
      at: event.at,
      tone: kind === 'warning' || kind === 'error' ? kind : 'info',
      label: 'feedback',
      body:
        typeof message === 'string'
          ? message
          : typeof phase === 'string'
            ? phase
            : event.message || workflowCopy.logEmpty,
    };
  }
  return null;
}

function isTone(value: unknown): value is WorkflowLogTone {
  return value === 'debug' || value === 'info' || value === 'warning' || value === 'error';
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}
