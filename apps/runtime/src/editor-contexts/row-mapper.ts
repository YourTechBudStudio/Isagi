import { type InferSelectModel } from 'drizzle-orm';

import { editorContexts, ptyProcesses } from '../persistence/schema.js';
import { ptyProcessRow } from '../pty-processes/index.js';
import type { EditorAttemptRecord, EditorContextRow } from './types.js';

type EditorContextRecord = InferSelectModel<typeof editorContexts>;
type PtyProcessRecord = InferSelectModel<typeof ptyProcesses>;

/**
 * Raised when a persisted `editor_contexts` row cannot mean anything. Every
 * write path in this package makes these states unreachable, so reaching one is
 * a defect in the runtime, not a failure a caller can handle — which is exactly
 * why this decoder runs *outside* `RuntimeDatabase.use`. Inside it, the throw
 * would be caught by `Effect.try` and delivered as a `DatabaseError`, reporting
 * a lifecycle bug as an expected database fault.
 *
 * The message names the context and the rule it broke and nothing else: a
 * defect that escapes to a log must not carry arbitrary database contents. The
 * attempt vocabulary is a closed literal set, so naming a reason is safe.
 */
export class EditorContextRowInvariantViolation extends Error {
  constructor(
    readonly editorContextId: number,
    readonly invariant: string,
  ) {
    super(`Editor context ${editorContextId} violates row invariant: ${invariant}.`);
    this.name = 'EditorContextRowInvariantViolation';
  }
}

/**
 * The single decoder from an `editor_contexts` table row to the domain row.
 * Both this package's repository and the surfaces read composition go through
 * it, so the attempt union is decoded — and the invariants are checked — in
 * exactly one place.
 */
export function editorContextRow(
  record: EditorContextRecord,
  process: PtyProcessRecord | null,
): EditorContextRow {
  const attempt = decodeAttempt(record);
  assertPointerInvariants(record, attempt);
  return {
    id: record.id,
    worktreeId: record.worktreeId,
    activePtyProcessId: record.activePtyProcessId,
    endpointHost: record.endpointHost,
    endpointPort: record.endpointPort,
    sessionSocketPath: record.sessionSocketPath,
    attempt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    activePtyProcess: process ? ptyProcessRow(process) : null,
  };
}

/**
 * Invariants 3, 4, and the started-at correspondence: each state owns exactly
 * the columns its union member declares, so a `failed` row always has a reason
 * and a `none` row can never carry a stale one.
 */
function decodeAttempt(record: EditorContextRecord): EditorAttemptRecord {
  const violation = (invariant: string) =>
    new EditorContextRowInvariantViolation(record.id, invariant);
  switch (record.attemptState) {
    case 'none':
      if (record.attemptReason !== null || record.attemptDetail !== null)
        throw violation('attempt=none carries a reason or detail');
      if (record.attemptStartedAt !== null) throw violation('attempt=none carries a started-at');
      return { state: 'none' };
    case 'in_progress':
      if (record.attemptReason !== null || record.attemptDetail !== null)
        throw violation('attempt=in_progress carries a reason or detail');
      if (record.attemptStartedAt === null)
        throw violation('attempt=in_progress has no started-at');
      return { state: 'in_progress', startedAt: record.attemptStartedAt };
    case 'failed':
      if (record.attemptReason === null) throw violation('attempt=failed has no reason');
      if (record.attemptStartedAt !== null) throw violation('attempt=failed carries a started-at');
      return { state: 'failed', reason: record.attemptReason, detail: record.attemptDetail };
    default:
      throw violation(`attempt state is not a known state`);
  }
}

/**
 * Invariants 1, 2, and 5. The pointer and the two endpoint facts plus the
 * socket are installed and cleared in single statements, so a partial set means
 * something wrote them another way. `failed` beside a live pointer is legal in
 * exactly one case — a replacement refused because its predecessor could not be
 * affirmatively stopped — because that is the only transition that records a
 * failure without first clearing ownership.
 */
function assertPointerInvariants(record: EditorContextRecord, attempt: EditorAttemptRecord) {
  const violation = (invariant: string) =>
    new EditorContextRowInvariantViolation(record.id, invariant);
  const hasPointer = record.activePtyProcessId !== null;
  const endpointSet =
    record.endpointHost !== null &&
    record.endpointPort !== null &&
    record.sessionSocketPath !== null;
  const endpointClear =
    record.endpointHost === null &&
    record.endpointPort === null &&
    record.sessionSocketPath === null;
  if (hasPointer && !endpointSet)
    throw violation('a pointer without a complete endpoint and session socket');
  if (!hasPointer && !endpointClear)
    throw violation('an endpoint or session socket without a pointer');
  if (attempt.state === 'in_progress' && hasPointer)
    throw violation('attempt=in_progress beside a pointer');
  if (
    attempt.state === 'failed' &&
    hasPointer &&
    attempt.reason !== 'previous_incarnation_not_stopped'
  )
    throw violation(`attempt=failed{${attempt.reason}} beside a retained pointer`);
}
