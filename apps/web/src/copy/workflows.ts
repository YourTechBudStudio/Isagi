import type { WorkflowErrorStage, WorkflowLoadFailureReason } from '@isagi/contracts';

export const workflowCopy = {
  // Cancel stops graph work. It does not delete anything, and it cannot promise that an external
  // process actually died — saying otherwise would be the one sentence this confirmation must not
  // contain.
  cancelConfirm: 'Cancel this workflow?',
  cancelConfirmDetail:
    'Isagi stops the remaining steps and keeps everything recorded so far. Running headless jobs get a stop request; agent panes stay open.',
  cancelConfirmAction: 'Cancel workflow',
  cancelConfirmBack: 'Keep running',
  continuePrompt: 'Continue',
  outcomeFailure: 'This workflow finished with a failure.',
  pausedAnswerNote: 'Your answer is kept. The workflow carries on when you resume it.',
  preparing: 'Setting up the worktree and surface this run works in.',
  dismissLabel: 'Dismiss',
  dismissDetail: 'Clears the bar. The run and its history stay.',
  retryActionFailed: "Couldn't retry the workflow.",
  retryPinNote: 'Retry loads the latest verified build of this workflow.',
  cancelActionFailed: "Couldn't cancel the workflow.",
  dismissActionFailed: "Couldn't dismiss the workflow.",
  pauseActionFailed: "Couldn't pause the workflow.",
  resumeActionFailed: "Couldn't resume the workflow.",
  advanceActionFailed: "Couldn't advance the workflow.",
  loadFailed: "Couldn't load that workflow's verified artifact.",
  logEmpty: '// nothing recorded yet',
  logConnecting: 'connecting',
  logDisconnected: 'disconnected',
  logReadFailed: "Isagi couldn't read this workflow's activity.",
  logRetry: 'Try again',
} as const;

/**
 * Where a run stopped, in one sentence, chosen by the stage the runtime recorded.
 *
 * The runtime's own message is still shown beside this line as a framed diagnostic, so nothing is
 * lost for a bug report. `satisfies` keeps it complete: a stage added to the contract fails this
 * build rather than quietly falling through to a generic line.
 */
const workflowErrorStageHeadlines = {
  environment: "This workflow's worktree or surface couldn't be set up.",
  graph_init: "A graph's init code threw.",
  subgraph_parameters: "A subgraph's parameters couldn't be built.",
  node_function: 'A step in this workflow threw.',
  reducer: 'A state reducer refused an update.',
  edge: "This workflow's routing code threw.",
  graph_output: "A graph's outcome code threw.",
  subgraph_on_result: "A subgraph's result couldn't be mapped back.",
  checkpoint_plan: "A checkpoint couldn't work out what to capture.",
  checkpoint_capture: "A checkpoint couldn't capture its files.",
} as const satisfies Record<WorkflowErrorStage, string>;

export function workflowErrorStageHeadline(stage: WorkflowErrorStage): string {
  return workflowErrorStageHeadlines[stage];
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
  // The two structural reasons. A graph that does not verify and a build whose recorded structure
  // no longer matches its code are different problems, and collapsing them would send a person
  // looking in the wrong place.
  invalid_structure: "This workflow's graph didn't pass verification.",
  structure_mismatch: "This workflow's recorded structure no longer matches its build.",
  invalid_export: "This workflow's artifact does not export a valid workflow.",
} as const satisfies Record<WorkflowLoadFailureReason, string>;

export function workflowLoadFailureReasonCopy(reason: WorkflowLoadFailureReason): string {
  return workflowLoadFailureCopy[reason];
}

export function workflowLoadFailureReasonCopyOrFallback(reason: string): string {
  return workflowLoadFailureCopy[reason as WorkflowLoadFailureReason] ?? workflowCopy.loadFailed;
}

export const workflowEnvironmentCopy = {
  preparationFailedTitle: "Couldn't prepare the environment.",
  preparationCancelledTitle: 'Cancelled while preparing the environment.',
  preparationCancelledBody: 'The workflow never started.',
  /**
   * The launch went through and the follow-up read did not.
   *
   * Reporting a failed read as a failed launch would tell somebody their workflow did not start
   * while a run sits behind it.
   */
  // "that run", not "that launch": the same sentence is shown after a Retry.
  summaryUnreadableTitle: "Couldn't read what happened to that run.",
  summaryUnreadableBody: 'The workflow started, so its run is there.',
  nothingCreated: 'Nothing was created.',
  nothingDeleted: 'Nothing was deleted.',
  retryKeepsWhatExists: 'Retry keeps what was already created and picks up from there.',
  diagnosticLabel: 'Runtime detail',
} as const;

/**
 * What this launch brought into existence, in one sentence, or that it brought nothing.
 *
 * Only what the run created counts: a worktree or surface it was placed on already is not news.
 */
export function workflowEnvironmentCreatedLine(created: {
  /** Already compacted for display by the caller; this file formats, it does not resolve paths. */
  readonly worktreePath: string | null;
  readonly surface: boolean;
}): string {
  const phrases = [
    created.worktreePath === null ? null : `the worktree at ${created.worktreePath}`,
    created.surface ? 'a surface for it' : null,
  ].filter((phrase): phrase is string => phrase !== null);
  if (phrases.length === 0) return workflowEnvironmentCopy.nothingCreated;
  return `Before it stopped, Isagi created ${phrases.join(' and ')}.`;
}
