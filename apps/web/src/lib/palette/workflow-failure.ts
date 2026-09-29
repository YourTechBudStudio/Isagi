import { Schema } from 'effect';

import type { StartWorkflowInput, WorkflowRunSummary } from '@isagi/contracts';
import { workflowRejectedErrorSchema } from '@isagi/contracts';

import {
  apiErrorDiagnostic,
  endpointDiagnostic,
  paletteCopy,
  runtimeErrorCopy,
  workflowCopy,
  workflowEnvironmentCopy,
  workflowEnvironmentCreatedLine,
  workflowErrorStageHeadline,
} from '../../copy/index.js';
import { classifyRuntimeFailure, type ClassifiedRuntimeFailure } from '../runtime/classify.js';
import { compactHomePath } from '../workspace/selectors.js';
import type { CommandErrorContent, CommandOutcome, WorkflowFailurePresentation } from './types.js';

// This adapter turns a runtime-client failure into web-owned palette copy. It is
// deliberately independent of workspace data code (`runtime-data.ts`): it selects
// stable sentences from `paletteCopy`/`runtimeErrorCopy` by classified failure
// kind and frames absolute paths as diagnostics only. It never decodes an API
// error to author primary copy, and it never reaches a workflow-start descriptor.

const failureCopy = paletteCopy.workflows.failure;

function isWorkflowDiscoveryFailure(
  apiError: Schema.Schema.Type<typeof workflowRejectedErrorSchema>,
) {
  return apiError.data.reason === 'workflow_discovery_failed';
}

/**
 * Presentation for a whole-list descriptor-query failure. Source-scan rejections
 * (`workflow_discovery_failed`) read as a scan failure with the failing source
 * path; every other failure reads as a generic "couldn't load workflows" row so
 * the palette never invents a scan cause it cannot substantiate.
 */
export function workflowFailurePresentation(error: unknown): WorkflowFailurePresentation {
  const classified = classifyRuntimeFailure(error);

  if (
    classified.kind === 'api' &&
    Schema.is(workflowRejectedErrorSchema)(classified.apiError) &&
    isWorkflowDiscoveryFailure(classified.apiError)
  ) {
    return {
      label: failureCopy.discovery.label,
      sub: failureCopy.discovery.sub,
      content: {
        title: failureCopy.discovery.title,
        body: failureCopy.discovery.body,
        diagnostic: {
          label: failureCopy.diagnosticLabel,
          detail: apiErrorDiagnostic(classified.apiError),
        },
      },
    };
  }

  const generic = failureCopy.generic;
  const base = { label: generic.label, sub: generic.sub };

  if (classified.kind === 'api') {
    return {
      ...base,
      content: {
        title: generic.title,
        body: runtimeErrorCopy.fromApiError(classified.apiError),
        diagnostic: {
          label: failureCopy.diagnosticLabel,
          detail: apiErrorDiagnostic(classified.apiError),
        },
      },
    };
  }

  if (classified.kind === 'transport') {
    return { ...base, content: { title: generic.title, body: runtimeErrorCopy.transport } };
  }

  if (classified.kind === 'decode') {
    return {
      ...base,
      content: {
        title: generic.title,
        body: runtimeErrorCopy.decode,
        diagnostic: {
          label: failureCopy.diagnosticLabel,
          detail: endpointDiagnostic(classified.endpointId),
        },
      },
    };
  }

  return { ...base, content: { title: generic.title, body: generic.body } };
}

/**
 * Error outcome for a workflow start that failed at (or after) launch-time
 * revalidation. Body is the reason-specific runtime-client sentence; the
 * diagnostic carries structured package/source paths for API failures and the
 * endpoint for decode failures, and is omitted for transport/unknown failures
 * where it would only repeat the body. A refusal from the workflow's `parse` gets its own
 * title; its message, like every workflow-authored message, is quoted in the diagnostic.
 *
 * Scope note: workflow start currently only produces runtime-client failures
 * (API/transport/decode/unknown), never a palette `UserVisibleError`. A future
 * caller adding local start validation must update this adapter deliberately
 * rather than relying on the `unknown` fallback below.
 */
export function workflowStartFailureContent(error: unknown): CommandErrorContent {
  const classified = classifyRuntimeFailure(error);
  const refused =
    classified.kind === 'api' &&
    Schema.is(workflowRejectedErrorSchema)(classified.apiError) &&
    classified.apiError.data.reason === 'workflow_parse_rejected';
  const title = refused
    ? paletteCopy.workflows.startRefused.title
    : paletteCopy.workflows.startFailed.title;
  return classifiedFailureContent(classified, title);
}

function runtimeFailureContent(error: unknown, title: string): CommandErrorContent {
  return classifiedFailureContent(classifyRuntimeFailure(error), title);
}

function classifiedFailureContent(
  classified: ClassifiedRuntimeFailure,
  title: string,
): CommandErrorContent {
  const label = paletteCopy.workflows.startFailed.diagnosticLabel;

  if (classified.kind === 'api') {
    return {
      title,
      body: runtimeErrorCopy.fromApiError(classified.apiError),
      diagnostic: { label, detail: apiErrorDiagnostic(classified.apiError) },
    };
  }

  if (classified.kind === 'transport') {
    return { title, body: runtimeErrorCopy.transport };
  }

  if (classified.kind === 'decode') {
    return {
      title,
      body: runtimeErrorCopy.decode,
      diagnostic: { label, detail: endpointDiagnostic(classified.endpointId) },
    };
  }

  return { title, body: runtimeErrorCopy.unknown };
}

/**
 * What the palette needs from the runtime to launch a workflow and report what happened.
 *
 * Launch and Retry return as soon as the run exists; its environment is prepared in the
 * background. `awaitPrepared` waits for that to finish, which is what lets every sentence below be
 * about facts rather than hopes.
 */
export interface WorkflowLaunchDeps {
  /** Answers only which run was created. */
  readonly start: (input: StartWorkflowInput) => Promise<{ readonly runId: number }>;
  /** Its own small result says nothing this adapter reports. */
  readonly retry: (runId: number) => Promise<unknown>;
  /**
   * The run once it has left `preparing`. Deliberately a separate call from the two above: only
   * they decide whether a run exists, so a failure here is a different fact and must read as one.
   */
  readonly awaitPrepared: (runId: number) => Promise<WorkflowRunSummary>;
  /**
   * Called only when the environment was actually prepared, so a failed launch is not offered back
   * at the top of the palette.
   */
  readonly onPrepared?: ((runId: number) => void) | undefined;
}

/**
 * Start a workflow and say what preparing its environment did.
 *
 * A throw is a launch-time rejection, a transport failure or a decode failure — the person has to
 * change something, so that outcome offers no Retry.
 */
export async function workflowLaunchOutcome(
  input: StartWorkflowInput,
  deps: WorkflowLaunchDeps,
): Promise<CommandOutcome> {
  let started: { readonly runId: number };
  try {
    started = await deps.start(input);
  } catch (error) {
    return { kind: 'error', content: workflowStartFailureContent(error) };
  }
  return runOutcome(started.runId, deps);
}

/**
 * Retry a run whose preparation failed, and report the same way.
 *
 * A refusal is reported with Close only. Offering Retry again after the runtime has said this run
 * cannot be retried would be a button that is guaranteed not to work.
 */
export async function workflowRetryOutcome(
  runId: number,
  deps: WorkflowLaunchDeps,
): Promise<CommandOutcome> {
  try {
    await deps.retry(runId);
  } catch (error) {
    return {
      kind: 'error',
      content: runtimeFailureContent(error, workflowCopy.retryActionFailed),
    };
  }
  return runOutcome(runId, deps);
}

/**
 * Wait for the run's preparation and report it — or, if it cannot be read, say exactly that.
 *
 * The run exists by the time this is called, so a failure here is never "it didn't start", and its
 * action is simply to ask again.
 */
async function runOutcome(runId: number, deps: WorkflowLaunchDeps): Promise<CommandOutcome> {
  let summary: WorkflowRunSummary;
  try {
    summary = await deps.awaitPrepared(runId);
  } catch (error) {
    const classified = runtimeFailureContent(error, workflowEnvironmentCopy.summaryUnreadableTitle);
    return {
      kind: 'error',
      content: {
        ...classified,
        body: paragraphs([workflowEnvironmentCopy.summaryUnreadableBody, classified.body ?? null]),
        actions: [
          {
            value: 'read-again',
            label: paletteCopy.outcome.tryAgain,
            intent: 'primary',
            run: () => runOutcome(runId, deps),
            running: paletteCopy.workflows.readingRun,
          },
          { value: 'close', label: paletteCopy.outcome.close },
        ],
      },
    };
  }
  return preparationOutcome(summary, deps);
}

/**
 * One mapping from a prepared (or not) run to what the palette shows, used by both the launch and
 * every Retry after it — which is what lets a retry that fails again offer Retry again.
 */
function preparationOutcome(summary: WorkflowRunSummary, deps: WorkflowLaunchDeps): CommandOutcome {
  const failedPreparing = summary.status === 'failed' && summary.error?.stage === 'environment';
  // The first status after `preparing` is what `awaitPrepared` returns, so `cancelled` here means
  // the run was cancelled while its environment was still being prepared.
  const cancelledPreparing = summary.status === 'cancelled';

  if (!failedPreparing && !cancelledPreparing) {
    deps.onPrepared?.(summary.runId);
    return { kind: 'close' };
  }

  const created = createdLine(summary);
  const somethingExists = created !== workflowEnvironmentCopy.nothingCreated;

  if (cancelledPreparing) {
    return {
      kind: 'result',
      content: {
        // Amber, not red: nothing broke, the person stopped it.
        tone: 'warning',
        title: workflowEnvironmentCopy.preparationCancelledTitle,
        body: paragraphs([
          workflowEnvironmentCopy.preparationCancelledBody,
          created,
          somethingExists ? workflowEnvironmentCopy.nothingDeleted : null,
        ]),
      },
    };
  }

  const retryable = summary.controls.retry;
  return {
    kind: 'error',
    content: {
      title: workflowEnvironmentCopy.preparationFailedTitle,
      body: paragraphs([
        workflowErrorStageHeadline('environment'),
        created,
        somethingExists
          ? [
              retryable ? workflowEnvironmentCopy.retryKeepsWhatExists : null,
              workflowEnvironmentCopy.nothingDeleted,
            ]
              .filter(Boolean)
              .join(' ')
          : null,
      ]),
      // The runtime's own message: Git's or the setup hook's words, framed as a diagnostic.
      ...(summary.error
        ? {
            diagnostic: {
              label: workflowEnvironmentCopy.diagnosticLabel,
              detail: summary.error.message,
            },
          }
        : {}),
      ...(retryable
        ? {
            actions: [
              {
                value: 'retry',
                label: paletteCopy.outcome.retry,
                intent: 'primary' as const,
                run: () => workflowRetryOutcome(summary.runId, deps),
                running: paletteCopy.workflows.retrying,
              },
              { value: 'close', label: paletteCopy.outcome.close },
            ],
          }
        : {}),
    },
  };
}

/** What the run created for itself: a `create` worktree or surface that preparation saved. */
function createdLine(summary: WorkflowRunSummary): string {
  const request = summary.placement.request;
  const worktreeCreated = request.worktree.kind === 'create' && summary.worktreePath !== null;
  return workflowEnvironmentCreatedLine({
    worktreePath: worktreeCreated ? compactHomePath(summary.worktreePath!) : null,
    surface: request.surface.kind === 'create' && summary.surfaceId !== null,
  });
}

/** Blank-line separated paragraphs; the outcome body renders newlines. */
function paragraphs(lines: readonly (string | null)[]): string {
  return lines.filter((line): line is string => Boolean(line)).join('\n\n');
}
