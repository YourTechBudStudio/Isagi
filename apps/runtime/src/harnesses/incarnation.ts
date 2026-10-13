/**
 * One execution of an agent's native harness: a PTY process or an SDK worker. Observation keys
 * records, active turns and liveness by incarnation, so a late record from an earlier execution
 * can never pose as the current one.
 */
export type Incarnation = `pty:${number}` | `sdk:${string}`;

export const ptyIncarnation = (ptyProcessId: number): Incarnation => `pty:${ptyProcessId}`;

export const sdkIncarnation = (executionId: string): Incarnation => `sdk:${executionId}`;

/** The execution a hook ledger record was written by, or `null` for legacy and unmarked records. */
export const ledgerIncarnation = (record: {
  readonly ptyProcessId: number | null;
  readonly sdkExecutionId: string | null;
}): Incarnation | null =>
  record.ptyProcessId !== null
    ? ptyIncarnation(record.ptyProcessId)
    : record.sdkExecutionId !== null
      ? sdkIncarnation(record.sdkExecutionId)
      : null;

/**
 * From `since` (ISO time, a lower bound on anything the execution writes) the agent was controlled
 * by `incarnation`, or by nothing when it is `null`.
 */
export interface ExecutionInterval {
  readonly incarnation: Incarnation | null;
  readonly since: string;
}

/** The execution a harness launch envelope is built for. */
export type ProcessIncarnation =
  | { readonly kind: 'pty'; readonly ptyProcessId: number }
  | { readonly kind: 'sdk'; readonly executionId: string };
