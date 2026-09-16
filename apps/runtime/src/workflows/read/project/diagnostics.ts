import { Either, Schema } from 'effect';

import { workflowDiagnosticDetailSchema, type WorkflowDiagnosticDetail } from '@isagi/contracts';

const decode = Schema.decodeUnknownEither(workflowDiagnosticDetailSchema);

/**
 * The one place a recorded `log`/`ui_feedback` detail becomes a typed fact.
 *
 * Both the projection and every client read the same shape, so decoding it here rather than
 * duck-typing fields at each reader is what keeps a writer change from silently blanking a
 * diagnostic somewhere downstream. Content that does not decode is `null`: not a guess, and not a
 * half-populated record.
 */
export function decodeDiagnosticDetail(value: unknown): WorkflowDiagnosticDetail | null {
  return Either.getOrNull(decode(value));
}
