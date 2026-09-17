import type {
  WorkflowDiagnosticCode,
  WorkflowEnvironmentFailureReason,
  WorkflowFailureCode,
  WorkflowLoadFailureReason,
  WorkflowSurfaceReceipt,
  WorkflowWorktreeReceipt,
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

  // Preparing the environment is a segment like any other, so it fails like one. The step and the
  // reason are the useful facts and they live on the preparation record, which is where the palette
  // and the inspector read them from; this is the one-line version for a run that only shows a code.
  environment_preparation_failed: "This workflow's environment could not be prepared.",
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

/**
 * What a preparation failure knew about itself, in the shapes the sentences need.
 *
 * Which of these exists is decided by the reason — a `surface_busy` has no branch, a
 * `branch_exists` has no occupying run — so every field is optional and every line below reads
 * correctly without it. The alternative, a sentence that names a field the runtime never recorded,
 * is the one thing this copy must not do.
 */
export interface WorkflowEnvironmentFailureFacts {
  readonly branch?: string | undefined;
  readonly occupyingRunId?: number | undefined;
  readonly hook?: { readonly index: number; readonly type: string } | undefined;
}

/**
 * A placement that named a row which is now gone cannot be retried into existence.
 *
 * Retry replays the recorded placement request verbatim — the request *is* the decision, and the
 * author's selector is deliberately never asked again — so re-resolving an id whose row has been
 * deleted fails identically every time. The only real next move is a new launch.
 */
const placementIsFixed = 'This run can only go where it was placed, so start the workflow again.';

/**
 * Why preparing the environment stopped, in one sentence, and whether Retry can change the answer.
 *
 * Every `line` is a function of the facts the runtime recorded, so a reason that has an identity to
 * name can name it and still read as a whole sentence when it does not. `satisfies` over the
 * contract union is what keeps the set complete: a reason added to the contract fails this build
 * rather than silently falling through to a generic line.
 *
 * `retryable: false` is reserved for the reasons where Retry would re-run the identical request
 * against the identical missing row and return the identical panel — an offer that cannot work. The
 * rest keep Retry, and each names what to change first where there is something to change; only
 * `git_failed`, `setup_failed`, `workspace_rejected` and `interrupted` end without advice, because
 * for those "try it again" genuinely is the next move.
 */
const workflowEnvironmentFailureLines = {
  worktree_missing: {
    retryable: false,
    line: () => `That worktree isn't there anymore. ${placementIsFixed}`,
  },
  surface_missing: {
    retryable: false,
    line: () => `That surface isn't there anymore. ${placementIsFixed}`,
  },
  surface_not_on_worktree: {
    retryable: false,
    line: () => `That surface belongs to a different worktree. ${placementIsFixed}`,
  },
  branch_exists: {
    retryable: true,
    line: ({ branch }) =>
      branch
        ? `Branch ${branch} already exists, so Isagi didn't create a worktree from it. Retry once it's gone, or start again with a different name.`
        : "That branch already exists, so Isagi didn't create a worktree from it. Retry once it's gone, or start again with a different name.",
  },
  worktree_exists: {
    retryable: true,
    line: ({ branch }) =>
      branch
        ? `There's already a worktree for ${branch}. Retry once it's gone, or start again with a different branch.`
        : "There's already a worktree for that branch. Retry once it's gone, or start again with a different branch.",
  },
  checkout_path_unavailable: {
    retryable: true,
    line: () =>
      'Something is already at the path Isagi would have checked out into. Clear it, then retry.',
  },
  git_failed: { retryable: true, line: () => "Git wouldn't create the worktree." },
  setup_trust_required: {
    retryable: true,
    line: () =>
      'The setup hooks need to be trusted before they can run. Open the worktree once to review them, then retry.',
  },
  setup_failed: {
    retryable: true,
    line: ({ hook }) =>
      hook
        ? `Setup hook ${hook.index} (${hook.type}) didn't finish.`
        : "A setup hook didn't finish.",
  },
  workspace_rejected: { retryable: true, line: () => "Isagi couldn't set up that environment." },
  surface_busy: {
    retryable: true,
    line: ({ occupyingRunId }) =>
      occupyingRunId
        ? `That surface already has a workflow on it (run #${occupyingRunId}). Dismiss that run, then retry.`
        : 'That surface already has a workflow on it. Dismiss that run, then retry.',
  },
  interrupted: {
    retryable: true,
    line: () => 'Isagi stopped part-way through preparing the environment.',
  },
} as const satisfies Record<
  WorkflowEnvironmentFailureReason,
  {
    readonly retryable: boolean;
    readonly line: (facts: WorkflowEnvironmentFailureFacts) => string;
  }
>;

export const workflowEnvironmentCopy = {
  preparationFailedTitle: "Couldn't prepare the environment.",
  preparationCancelledTitle: 'Cancelled while preparing the environment.',
  preparationCancelledBody: 'The workflow never started.',
  /**
   * A failure the summary could not describe.
   *
   * Three different things produce it — the failing attempt belongs to another segment, there is no
   * failing attempt at all after a recovery, or the recorded detail did not read back — and this
   * line is true of all three. Naming a cause here, such as an interruption, would be asserting one
   * of the three as fact.
   */
  preparationReasonUnknown: "Isagi can't say where preparing the environment stopped.",
  /**
   * The launch went through and the follow-up read did not.
   *
   * Two runtime calls answer one question — "did this work" — and only the first of them decides
   * whether a run exists. Reporting a failed read as a failed launch would tell somebody their
   * workflow did not start while a prepared run with a live attachment sits behind it.
   */
  // "that run", not "that launch": the same sentence is shown after a Retry, and the run is what
  // both paths have in common.
  summaryUnreadableTitle: "Couldn't read what happened to that run.",
  summaryUnreadableBody: 'The workflow started, so its run is there.',
  // The launch request blocks until preparation is decided, so reaching this means something below
  // Isagi restarted mid-launch. It says what is true and offers nothing it cannot deliver.
  preparationPendingTitle: 'Still preparing the environment.',
  preparationPendingBody:
    "The run exists and is still setting itself up. It'll appear once it has somewhere to work.",
  nothingCreated: 'Nothing was created.',
  nothingDeleted: 'Nothing was deleted.',
  retryFromSetup: 'Retry runs setup again on the same worktree.',
  retryOnSameWorktree: 'Retry picks up on the same worktree.',
  setupOutputLabel: 'Setup output',
  diagnosticLabel: 'Runtime detail',
} as const;

export function workflowEnvironmentFailureLine(
  reason: WorkflowEnvironmentFailureReason,
  facts: WorkflowEnvironmentFailureFacts = {},
): string {
  return workflowEnvironmentFailureLines[reason].line(facts);
}

/**
 * Whether Retry could produce a different answer for this reason.
 *
 * Asked by the outcome before it offers Retry at all: an action that is guaranteed to return the
 * same panel is not a next step, it is a loop. Unknown reasons are not this function's problem — a
 * failure the summary could not describe is still retryable, and the caller decides that.
 */
export function workflowEnvironmentFailureRetryable(
  reason: WorkflowEnvironmentFailureReason,
): boolean {
  return workflowEnvironmentFailureLines[reason].retryable;
}

/**
 * What this launch brought into existence, in one sentence, or that it brought nothing.
 *
 * Receipts are written only for allocations, so this sentence can never over-claim: a reused
 * worktree or surface leaves none. An adopted worktree still reads as "created" because an earlier
 * attempt of this same run is what created it — the run is the subject, not the attempt.
 */
export function workflowEnvironmentCreatedLine(receipts: {
  readonly worktree: WorkflowWorktreeReceipt | null;
  readonly surface: WorkflowSurfaceReceipt | null;
  /** Already compacted for display by the caller; this file formats, it does not resolve paths. */
  readonly worktreePath?: string | undefined;
}): string {
  const { worktree, surface } = receipts;
  const path = receipts.worktreePath ?? worktree?.worktreePath;
  const worktreePhrase = worktree
    ? worktree.branch
      ? `the worktree ${worktree.branch} at ${path}`
      : `the worktree at ${path}`
    : null;
  const surfacePhrase = surface ? `the surface "${surface.title}"` : null;
  const phrases = [worktreePhrase, surfacePhrase].filter(
    (phrase): phrase is string => phrase !== null,
  );
  if (phrases.length === 0) {
    return workflowEnvironmentCopy.nothingCreated;
  }
  return `Before it stopped, Isagi created ${phrases.join(' and ')}.`;
}

/**
 * What Retry would do, given what already exists — or nothing, when Retry is not being offered.
 *
 * Silent in both directions on purpose: describing a Retry that is not on the panel would name an
 * action the person cannot take, and describing one when nothing was allocated would promise
 * continuity that does not exist.
 */
export function workflowEnvironmentRetryLine(input: {
  readonly worktree: WorkflowWorktreeReceipt | null;
  readonly failedAtSetup: boolean;
  readonly retryable: boolean;
}): string | null {
  if (input.worktree === null || !input.retryable) {
    return null;
  }
  return input.failedAtSetup
    ? workflowEnvironmentCopy.retryFromSetup
    : workflowEnvironmentCopy.retryOnSameWorktree;
}
