import type {
  EditorAttemptFailureReason,
  EditorContextFacts,
  EditorProcessDiagnostic,
  SessionStatus,
} from '@isagi/contracts';

/**
 * The editor pane's pure state machine. Surface detail carries a projection of
 * three independent facts — the durable launch attempt, the incarnation's PTY
 * status, and the runtime's readiness observation — and this reduces them to the
 * one thing the pane renders.
 *
 * The parameter is `EditorContextFacts` rather than the pane-bound
 * `EditorContextMetadata`, which is structurally assignable to it: placement is a
 * surfaces fact that changes nothing here, and taking the narrower type keeps the
 * function usable against an `ensureRuntime` response as well as a pane.
 */
export type EditorPaneView =
  | { readonly kind: 'launching' }
  | { readonly kind: 'waiting_for_workbench' }
  | { readonly kind: 'ready'; readonly url: string }
  /** Nothing has ever run here: no attempt, no incarnation. */
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'settled';
      readonly reason: EditorSettledReason;
      readonly detail: string | null;
    };

export type EditorSettledReason =
  | { readonly kind: 'attempt_failed'; readonly reason: EditorAttemptFailureReason }
  | { readonly kind: 'process'; readonly diagnostic: EditorProcessDiagnostic }
  | { readonly kind: 'unreachable' }
  /** A live pointer with no current readiness observation: uncertainty, not failure. */
  | { readonly kind: 'unknown' };

/**
 * A failed attempt that left the previous incarnation standing. It is reported
 * *alongside* whatever the surviving process is doing rather than instead of it,
 * because both facts are true: the replacement did not happen, and the old editor
 * is still there. Null whenever the attempt failure is already the pane's whole
 * state (rule 1) or no attempt has failed.
 */
export interface EditorAttemptBanner {
  readonly reason: EditorAttemptFailureReason;
  readonly detail: string | null;
}

/**
 * A terminal PTY status always arrives with the runtime's own diagnostic. This
 * only exists to keep the reduction total: the two statuses that name themselves
 * map across directly, and a bare `failed` can only have been a launch that never
 * came up.
 */
const DIAGNOSTIC_FOR_TERMINAL_STATUS = {
  exited: 'exited',
  killed: 'killed',
  failed: 'launch_failed',
} as const satisfies Partial<Record<SessionStatus, EditorProcessDiagnostic>>;

function isTerminal(status: SessionStatus): status is keyof typeof DIAGNOSTIC_FOR_TERMINAL_STATUS {
  return status === 'exited' || status === 'failed' || status === 'killed';
}

export function editorPaneView(context: EditorContextFacts): EditorPaneView {
  const { attempt, processStatus, workbenchReadiness, endpoint } = context;

  // 1. A failed attempt owns the pane only when it left nothing running. The
  //    `processStatus === null` guard is what makes the refused replacement fall
  //    through to the process rules below instead of hiding a live incarnation.
  if (attempt.state === 'failed' && processStatus === null) {
    return {
      kind: 'settled',
      reason: { kind: 'attempt_failed', reason: attempt.reason },
      detail: attempt.detail,
    };
  }
  // 2. An attempt in flight outranks whatever the outgoing incarnation says.
  if (attempt.state === 'in_progress') return { kind: 'launching' };
  // 3. No pointer and no attempt: nothing has ever run here.
  if (processStatus === null) return { kind: 'idle' };
  // 4. The incarnation is gone. Its diagnostic is the honest reason.
  if (isTerminal(processStatus)) {
    return {
      kind: 'settled',
      reason: {
        kind: 'process',
        diagnostic: context.processDiagnostic ?? DIAGNOSTIC_FOR_TERMINAL_STATUS[processStatus],
      },
      detail: context.processDiagnosticDetail,
    };
  }
  // 5. Live, observed ready, and the runtime composed an origin to frame.
  if (workbenchReadiness === 'ready' && endpoint) return { kind: 'ready', url: endpoint.url };
  // 6-8. Live, and the readiness observation is the whole story.
  if (workbenchReadiness === 'pending') return { kind: 'waiting_for_workbench' };
  if (workbenchReadiness === 'unreachable') {
    return { kind: 'settled', reason: { kind: 'unreachable' }, detail: context.readinessDetail };
  }
  if (workbenchReadiness === 'unknown') {
    return { kind: 'settled', reason: { kind: 'unknown' }, detail: context.readinessDetail };
  }
  // 9. Starting, with nothing observed yet — including a `ready` reading with no
  //    endpoint, which is not something the pane can frame.
  return { kind: 'launching' };
}

/**
 * The contract code the runtime settled this pane with — `port_allocation_failed`,
 * `exited`, `unreachable`. It is the label the pane puts in front of a raw
 * `detail` string so the runtime's own evidence is never mistaken for Isagi's
 * voiced sentence, matching the `code · detail` framing a restore prompt and the
 * provisioning diagnostic chip already use.
 */
export function editorSettledCode(reason: EditorSettledReason): string {
  switch (reason.kind) {
    case 'attempt_failed':
      return reason.reason;
    case 'process':
      return reason.diagnostic;
    case 'unreachable':
    case 'unknown':
      return reason.kind;
  }
}

export function editorAttemptBanner(context: EditorContextFacts): EditorAttemptBanner | null {
  const { attempt, processStatus } = context;
  if (attempt.state !== 'failed' || processStatus === null) return null;
  return { reason: attempt.reason, detail: attempt.detail };
}

/**
 * `reuse` performs the genuine first launch; every settled state is recovered by
 * replacing the incarnation. Nothing is offered while a launch or a probe is
 * still running, so a merely slow workbench cannot be cut short.
 */
export type EditorStartIntent = 'reuse' | 'replace';

export function editorStartIntent(view: EditorPaneView): EditorStartIntent | null {
  if (view.kind === 'idle') return 'reuse';
  if (view.kind === 'settled') return 'replace';
  return null;
}

/**
 * A pending ensure owns the prompt only when it is performing the action that
 * prompt currently offers. In particular, the automatic mount-time `reuse`
 * must not turn a settled pane's explicit `replace` action into a disabled
 * "Starting…" button if that background request outlives the runtime.
 */
export function editorStartIsPending(
  view: EditorPaneView,
  pendingIntent: EditorStartIntent | null,
): boolean {
  const offeredIntent = editorStartIntent(view);
  return offeredIntent !== null && offeredIntent === pendingIntent;
}
