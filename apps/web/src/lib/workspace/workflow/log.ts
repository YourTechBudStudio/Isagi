import { Either, Schema } from 'effect';

import {
  workflowDiagnosticDetailSchema,
  type WorkflowPayloadRef,
  type WorkflowRunTransitionDelta,
} from '@isagi/contracts';

import { workflowCopy, workflowDiagnosticCodeCopy } from '../../../copy/index.js';

const decodeDetail = Schema.decodeUnknownEither(workflowDiagnosticDetailSchema);

export type WorkflowLogTone = 'debug' | 'info' | 'warning' | 'error';

/**
 * One line of the bar's recent-activity log.
 *
 * `body` is always something honest to show. Authored content is the author's own words; a runtime
 * diagnostic is Isagi's sentence with the runtime's raw text kept beside it as `diagnostic`; and a
 * detail that is stored rather than inline, or that does not decode at all, says exactly that
 * instead of rendering an empty line.
 */
export interface WorkflowLogLine {
  readonly revision: number;
  readonly recordedAt: string;
  readonly tone: WorkflowLogTone;
  readonly label: string;
  readonly body: string;
  /** The runtime's own text, for a bug report. Never the voiced line. */
  readonly diagnostic: string | null;
  /** Set when the detail lives behind a reference. Loaded only when the person asks for it. */
  readonly storedDetail: { readonly payloadRef: string; readonly byteSize: number } | null;
}

/** Only these two kinds are activity a person reads; every other transition is structure. */
export function isDiagnosticTransition(delta: WorkflowRunTransitionDelta): boolean {
  return delta.transition.kind === 'log' || delta.transition.kind === 'ui_feedback';
}

export function workflowLogLine(delta: WorkflowRunTransitionDelta): WorkflowLogLine | null {
  if (!isDiagnosticTransition(delta)) return null;
  const base = {
    revision: delta.revision,
    recordedAt: delta.transition.recordedAt,
    label: delta.transition.kind === 'ui_feedback' ? 'feedback' : 'log',
  } as const;

  const slot = delta.transition.detailRef;
  if (slot !== null && 'payloadRef' in slot) {
    return {
      ...base,
      tone: 'info',
      body: workflowCopy.logDetailStored,
      diagnostic: null,
      storedDetail: { payloadRef: slot.payloadRef, byteSize: slot.byteSize },
    };
  }

  return { ...base, ...lineFromDetail(slot) };
}

/**
 * Turns a fetched stored detail into the same line shape, so an expanded entry and an inline one
 * read identically rather than through two renderers that can drift.
 */
export function workflowLogLineFromPayload(line: WorkflowLogLine, value: unknown): WorkflowLogLine {
  return {
    revision: line.revision,
    recordedAt: line.recordedAt,
    label: line.label,
    ...lineFromDetail({ inline: value }),
    storedDetail: null,
  };
}

function lineFromDetail(slot: WorkflowPayloadRef | null): {
  readonly tone: WorkflowLogTone;
  readonly body: string;
  readonly diagnostic: string | null;
  readonly storedDetail: null;
} {
  const decoded = slot !== null && 'inline' in slot ? decodeDetail(slot.inline) : null;
  if (decoded === null || Either.isLeft(decoded)) {
    // Unknown, legacy or malformed content. Rendering guessed fields out of it would be the one
    // thing the typed detail exists to prevent, so the line says plainly that it cannot be read.
    return {
      tone: 'warning',
      body: workflowCopy.logDetailUnreadable,
      diagnostic: null,
      storedDetail: null,
    };
  }

  const detail = decoded.right;
  switch (detail.source) {
    case 'author_log':
      return {
        tone: detail.level,
        body: detail.message,
        diagnostic: null,
        storedDetail: null,
      };
    case 'ui_feedback':
      return {
        tone: detail.kind,
        body: detail.message ?? detail.phase ?? workflowCopy.logEmpty,
        diagnostic: null,
        storedDetail: null,
      };
    case 'runtime_diagnostic':
      return {
        tone: detail.level,
        body: workflowDiagnosticCodeCopy(detail.code),
        diagnostic: detail.message,
        storedDetail: null,
      };
  }
}
