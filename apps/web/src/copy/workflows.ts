import type { WorkflowLoadFailureReason } from '@isagi/contracts';

export const workflowCopy = {
  cancelConfirm: 'Cancel this workflow?',
  cancelConfirmDetail: 'The running step will finish its boundary, then the workflow is cleared.',
  cancelConfirmAction: 'Cancel workflow',
  cancelConfirmBack: 'Keep running',
  continuePrompt: 'Continue',
  retryActionFailed: "Couldn't retry the workflow.",
  clearActionFailed: "Couldn't clear the workflow.",
  pauseActionFailed: "Couldn't pause the workflow.",
  resumeActionFailed: "Couldn't resume the workflow.",
  advanceActionFailed: "Couldn't advance the workflow.",
  loadFailed: "Couldn't load that workflow's verified artifact.",
  logEmpty: '// no workflow events yet',
  logConnecting: 'connecting',
  logDisconnected: 'disconnected',
} as const;

const workflowLoadFailureCopy = {
  missing_build: 'This workflow needs a verified build before it can run.',
  invalid_manifest: "This workflow's build manifest is invalid.",
  unsupported_manifest: 'This workflow was built with an unsupported manifest format.',
  unsupported_contract: 'This workflow targets an unsupported workflow contract.',
  invalid_package: "This workflow's package metadata is invalid.",
  stale_source: 'This workflow changed after its last verified build.',
  artifact_tampered: "This workflow's built artifact no longer matches its manifest.",
  artifact_load_failed: "Couldn't load this workflow's verified artifact.",
  invalid_export: "This workflow's artifact does not export a valid workflow.",
  pinned_artifact_unavailable: "This run's verified workflow artifact is unavailable.",
} as const satisfies Record<WorkflowLoadFailureReason, string>;

export function workflowLoadFailureReasonCopy(reason: WorkflowLoadFailureReason): string {
  return workflowLoadFailureCopy[reason];
}

export function workflowLoadFailureReasonCopyOrFallback(reason: string): string {
  return workflowLoadFailureCopy[reason as WorkflowLoadFailureReason] ?? workflowCopy.loadFailed;
}
