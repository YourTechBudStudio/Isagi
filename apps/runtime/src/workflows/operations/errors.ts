import type { WorkflowFailureCode } from '@isagi/contracts';

/**
 * The stable `code` values a capability rejection can carry into author code.
 *
 * Author callbacks are plain async TypeScript, so a rejection is an ordinary `Error`. Carrying a
 * stable code on it lets an author catch and route a launch failure without the SDK growing an error
 * hierarchy, and lets the interpreter map the rejection to a failure code without parsing a message.
 */
export type OperationRejectionCode =
  | Extract<
      WorkflowFailureCode,
      | 'operation_prefix_unresolved'
      | 'operation_request_changed'
      | 'operation_uncertain'
      | 'operation_context_closed'
      /** `ctx.captureEvidence` refused the call; `detail.reason` names which rule it broke. */
      | 'evidence_capture_rejected'
    >
  | 'workflow_operation_launch_failed'
  | 'workflow_operation_failed'
  /** The run was cancelled or otherwise terminal, so it cannot authorize a new external effect. */
  | 'workflow_run_cancelled';

/** Rejected out of a `ctx` verb, and visible to author code exactly as thrown. */
export class OperationRejection extends Error {
  readonly code: OperationRejectionCode;
  readonly operationId: number | null;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(input: {
    readonly code: OperationRejectionCode;
    readonly message: string;
    readonly operationId?: number | null | undefined;
    readonly detail?: Readonly<Record<string, unknown>> | undefined;
    readonly cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = 'OperationRejection';
    this.code = input.code;
    this.operationId = input.operationId ?? null;
    this.detail = input.detail ?? {};
  }
}
