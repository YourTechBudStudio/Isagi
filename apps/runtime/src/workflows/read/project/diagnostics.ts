import { Either, Schema } from 'effect';

import {
  workflowDiagnosticDetailSchema,
  workflowEnvironmentFailureDetailSchema,
  type WorkflowDiagnosticDetail,
  type WorkflowEnvironmentFailureDetail,
} from '@isagi/contracts';

const decode = Schema.decodeUnknownEither(workflowDiagnosticDetailSchema);
const decodeEnvironment = Schema.decodeUnknownEither(workflowEnvironmentFailureDetailSchema);

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

/**
 * The recorded detail of a preparation failure, as the run summary reports it.
 *
 * Null covers three different things on purpose, and the client must read it as "no detail",
 * never as "no failure": the run did not fail while preparing, the failing attempt belongs to
 * another segment, or the recorded detail could not be read back. The last one is the reason this
 * degrades rather than throws — the summary is projected inside every workflow write, so a throw
 * here would fail the *transaction* that recorded the failure rather than merely lose a field. The
 * run-level `failure` still carries the code and the message in every one of those cases.
 */
export function decodeEnvironmentFailureDetail(
  value: unknown,
): WorkflowEnvironmentFailureDetail | null {
  return Either.getOrNull(decodeEnvironment(value));
}
