import type {
  WorkflowDiagnosticCode,
  WorkflowFailureCode,
  WorkflowLoadFailureReason,
} from '@isagi/contracts';

export const workflowCopy = {
  // Cancel stops graph work. It does not delete anything, and it cannot promise that an external
  // process actually died — saying otherwise would be the one sentence this confirmation must not
  // contain.
  cancelConfirm: 'Cancel this workflow?',
  cancelConfirmDetail:
    'Isagi stops the remaining steps and records everything so far. Work already handed to an agent or a process may keep running, or stop part-way.',
  cancelConfirmAction: 'Cancel workflow',
  cancelConfirmBack: 'Keep running',
  continuePrompt: 'Continue',
  outcomeFailure: 'This workflow finished with a failure.',
  pausedAnswerNote: 'This workflow stays paused after you answer.',
  dismissLabel: 'Dismiss',
  dismissDetail: 'Clears the bar. The run and its history stay.',
  retryActionFailed: "Couldn't retry the workflow.",
  retryPinNote: 'Retry loads the latest verified version of this workflow.',
  cancelActionFailed: "Couldn't cancel the workflow.",
  dismissActionFailed: "Couldn't dismiss the workflow.",
  pauseActionFailed: "Couldn't pause the workflow.",
  resumeActionFailed: "Couldn't resume the workflow.",
  advanceActionFailed: "Couldn't advance the workflow.",
  loadFailed: "Couldn't load that workflow's verified artifact.",
  logEmpty: '// nothing recorded yet',
  logConnecting: 'connecting',
  logDisconnected: 'disconnected',
  logLoadEarlier: 'Load earlier activity',
  logOlderAvailable: 'Earlier activity is not loaded.',
  logDetailStored: 'This entry is too large to show inline.',
  logDetailLoad: 'Load detail',
  logDetailUnreadable: "Isagi can't read this entry's detail.",
  logReadFailed: "Isagi couldn't read this workflow's recent activity.",
  logRetry: 'Try again',
  logDetailFailed: "Isagi couldn't read this entry's stored detail.",
  // Stop reporting. Cancel is best-effort by construction, so the bar says what was actually
  // confirmed rather than implying a clean stop.
  stopPending: 'Still waiting on external work to stop.',
  stopUnsupported: "Some external work can't be stopped from here, so it may still be running.",
  stopFailed: 'Some external work refused to stop.',
  blockedOperation:
    "Isagi can't confirm whether an external step went through, so the run is holding here.",
  environmentUnavailable: "This workflow's worktree isn't available, so it can't carry on.",
} as const;

/**
 * Why a run stopped, in one sentence, chosen by the runtime's stable failure code.
 *
 * Grouped on purpose: several codes describe the same thing happening to a person — the workflow's
 * own code threw, a state update was refused, a route could not be decided — and twenty-one nearly
 * identical sentences would be noise, not precision. The exact code and the runtime's own message
 * are still shown beside this line as framed diagnostics, so nothing is lost for a bug report.
 *
 * `satisfies` is what keeps it honest: a code added to the contract fails this build rather than
 * quietly falling through to a generic line.
 */
const workflowFailureHeadlines = {
  graph_init_failed: "This workflow's setup code threw.",
  node_callback_failed: 'A step in this workflow threw.',
  output_evaluation_failed: "This workflow's result code threw.",
  edge_choose_failed: "This workflow's routing code threw.",
  async_pure_callback: 'A step that must be synchronous returned a promise.',
  unsupported_node_kind: 'This workflow uses a step Isagi cannot run yet.',

  parameter_mapping_failed: "A subgraph's inputs could not be built.",
  output_mapping_failed: "A subgraph's result could not be mapped back.",

  reduction_failed: "A step's state update was refused.",
  reducer_failed: 'A state field rejected its update.',
  unknown_state_field: 'A step tried to update a field this graph never declared.',
  implicit_clear_rejected: 'A step left out a field instead of clearing it explicitly.',
  invalid_update_shape: "A step's state update had the wrong shape.",
  unserializable_state: 'A step produced state Isagi cannot record.',
  undeclared_destination: 'A route chose a destination the edge never declared.',

  // Not the same as "it failed". Nobody knows whether the external work landed.
  operation_uncertain:
    "Isagi can't tell whether an external step went through, so it stopped rather than guess.",
  operation_prefix_unresolved: 'A repeated step did not reissue the external calls it made before.',
  operation_prefix_unconsumed: 'A repeated step skipped external calls it made before.',
  operation_request_changed: 'A repeated step asked for something different the second time.',
  operation_context_closed: 'A step tried to call out after it had already finished.',

  payload_unavailable: 'A value this run recorded earlier could not be read back.',
} as const satisfies Record<WorkflowFailureCode, string>;

export function workflowFailureHeadline(code: WorkflowFailureCode): string {
  return workflowFailureHeadlines[code];
}

/**
 * What a runtime diagnostic means, in Isagi's words.
 *
 * The runtime's own `message` is a diagnostic fact for a bug report, not product copy, so the line
 * a person reads is chosen here by the stable code and the raw message is shown beside it as
 * clearly framed detail.
 */
const workflowDiagnosticCopy = {
  pinned_load_failed: "Isagi couldn't load the exact workflow version this run is pinned to.",
  // The segment still ran. Saying so matters: a missing name looks like a missing step otherwise.
  label_failed: "A step's display name couldn't be captured. The step itself still ran.",
  payload_unavailable: "Isagi couldn't read a value this run recorded earlier.",
} as const satisfies Record<WorkflowDiagnosticCode, string>;

export function workflowDiagnosticCodeCopy(code: WorkflowDiagnosticCode): string {
  return workflowDiagnosticCopy[code];
}

const workflowLoadFailureCopy = {
  missing_build: 'This workflow needs a verified build before it can run.',
  invalid_manifest: "This workflow's build manifest is invalid.",
  unsupported_manifest: 'This workflow was built with an unsupported manifest format.',
  unsupported_contract: 'This workflow targets an unsupported workflow contract.',
  invalid_package: "This workflow's package metadata is invalid.",
  stale_source: 'This workflow changed after its last verified build.',
  artifact_tampered: "This workflow's built artifact no longer matches its manifest.",
  artifact_load_failed: "Couldn't load this workflow's verified artifact.",
  // The three structural reasons. A graph that does not verify, a build whose recorded structure no
  // longer matches its code, and a workflow asking for something this runtime cannot provide are
  // three different problems, and collapsing them would send a person looking in the wrong place.
  invalid_structure: "This workflow's graph didn't pass verification.",
  structure_mismatch: "This workflow's recorded structure no longer matches its build.",
  unsupported_capability: 'This workflow uses a capability this runtime does not provide.',
  invalid_export: "This workflow's artifact does not export a valid workflow.",
  pinned_artifact_unavailable: "This run's verified workflow artifact is unavailable.",
} as const satisfies Record<WorkflowLoadFailureReason, string>;

export function workflowLoadFailureReasonCopy(reason: WorkflowLoadFailureReason): string {
  return workflowLoadFailureCopy[reason];
}

export function workflowLoadFailureReasonCopyOrFallback(reason: string): string {
  return workflowLoadFailureCopy[reason as WorkflowLoadFailureReason] ?? workflowCopy.loadFailed;
}
