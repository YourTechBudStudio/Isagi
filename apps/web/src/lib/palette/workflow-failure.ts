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
  workflowEnvironmentFailureLine,
  workflowEnvironmentFailureRetryable,
  workflowEnvironmentRetryLine,
  type WorkflowEnvironmentFailureFacts,
} from '../../copy/index.js';
import { classifyRuntimeFailure } from '../runtime/classify.js';
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
 * where it would only repeat the body.
 *
 * Scope note: workflow start currently only produces runtime-client failures
 * (API/transport/decode/unknown), never a palette `UserVisibleError`. A future
 * caller adding local start validation must update this adapter deliberately
 * rather than relying on the `unknown` fallback below.
 */
export function workflowStartFailureContent(error: unknown): CommandErrorContent {
  return runtimeFailureContent(error, paletteCopy.workflows.startFailed.title);
}

function runtimeFailureContent(error: unknown, title: string): CommandErrorContent {
  const classified = classifyRuntimeFailure(error);
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
 * Both calls block for the whole preparation, which is why they return the summary rather than an
 * acknowledgement: the answer to "did this work" is only knowable once preparation has finished,
 * and reading it once here is what lets every sentence below be about facts rather than hopes.
 */
export interface WorkflowLaunchDeps {
  /** Blocks until preparation is decided, and answers only which run was created. */
  readonly start: (input: StartWorkflowInput) => Promise<{ readonly runId: number }>;
  /** Blocks the same way. Its own small result says nothing this adapter reports. */
  readonly retry: (runId: number) => Promise<unknown>;
  /**
   * What the run says happened. Deliberately a separate call from the two above: only they decide
   * whether a run exists, so a failure here is a different fact and must read as one.
   */
  readonly readSummary: (runId: number) => Promise<WorkflowRunSummary>;
  /**
   * Called only when the environment was actually prepared.
   *
   * A launch that failed is still a launch the person attempted, but it is not one they would want
   * offered back to them at the top of the palette, and today's behaviour records the entry on
   * success only. Keeping that decision here rather than in the run effect is what preserves it.
   */
  readonly onPrepared?: ((runId: number) => void) | undefined;
}

/**
 * Start a workflow and say what preparing its environment did.
 *
 * The launch request blocks until preparation commits or fails, so by the time this returns there
 * is a decided answer to report. A throw is a launch-time rejection, a transport failure or a
 * decode failure — the person has to change something, so that outcome offers no Retry.
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
 * Retry a run whose preparation never finished, and report the same way.
 *
 * A refusal — the run moved on, another Retry won first, the control is stale — is reported with
 * Close only. Offering Retry again after the runtime has said this run cannot be retried would be
 * a button that is guaranteed not to work.
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
 * Read the run and report what it says — or, if it cannot be read, say exactly that.
 *
 * The run exists by the time this is called: the launch or the retry has already returned. So a
 * failure here is never "it didn't start", and it is the one failure in this file whose action is
 * simply to ask again, because nothing about the run needs to change first.
 */
async function runOutcome(runId: number, deps: WorkflowLaunchDeps): Promise<CommandOutcome> {
  let summary: WorkflowRunSummary;
  try {
    summary = await deps.readSummary(runId);
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
 * One mapping from a run's preparation record to what the palette shows, used by both the launch
 * and every Retry after it — which is what lets a retry that fails again offer Retry again.
 */
function preparationOutcome(summary: WorkflowRunSummary, deps: WorkflowLaunchDeps): CommandOutcome {
  const { preparation } = summary;

  if (preparation.status === 'prepared') {
    deps.onPrepared?.(summary.runId);
    return { kind: 'close' };
  }

  const created = createdLine(preparation);
  const somethingExists = preparation.worktree !== null || preparation.surface !== null;

  if (preparation.status === 'cancelled') {
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

  if (preparation.status === 'pending') {
    return {
      kind: 'result',
      content: {
        tone: 'info',
        title: workflowEnvironmentCopy.preparationPendingTitle,
        body: workflowEnvironmentCopy.preparationPendingBody,
      },
    };
  }

  const failure = preparation.failure;
  /**
   * A failure the summary could not describe is still retryable — one of its three causes is the
   * recovered state, which is exactly what Retry exists for. Only a reason that names a row which
   * is gone withholds it, because Retry replays the recorded request and would fail identically.
   */
  const retryable = failure === null || workflowEnvironmentFailureRetryable(failure.reason);
  const retry = workflowEnvironmentRetryLine({
    worktree: preparation.worktree,
    failedAtSetup: failure?.step === 'setup',
    retryable,
  });
  return {
    kind: 'error',
    content: {
      title: workflowEnvironmentCopy.preparationFailedTitle,
      body: paragraphs([
        failure
          ? workflowEnvironmentFailureLine(failure.reason, failureFacts(summary))
          : workflowEnvironmentCopy.preparationReasonUnknown,
        created,
        somethingExists
          ? [retry, workflowEnvironmentCopy.nothingDeleted].filter(Boolean).join(' ')
          : null,
      ]),
      ...(failure?.diagnostic
        ? {
            diagnostic: {
              label:
                failure.step === 'setup'
                  ? workflowEnvironmentCopy.setupOutputLabel
                  : workflowEnvironmentCopy.diagnosticLabel,
              detail: failure.diagnostic,
            },
          }
        : {}),
      // Close alone when Retry cannot work: the reason line names the real next move instead, and
      // an outcome with no actions already offers Close.
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

/**
 * The identities the failing step recorded, gathered for the sentence that names them.
 *
 * The hook comes from the setup receipt rather than the failure detail: the detail says which step
 * and why, and the receipt is where a failing hook's own index and type are kept.
 */
function failureFacts(summary: WorkflowRunSummary): WorkflowEnvironmentFailureFacts {
  const { failure, setup } = summary.preparation;
  const hookFailure = setup?.failure ?? null;
  return {
    ...(failure?.branch === undefined ? {} : { branch: failure.branch }),
    ...(failure?.occupyingRunId === undefined ? {} : { occupyingRunId: failure.occupyingRunId }),
    ...(hookFailure === null
      ? {}
      : { hook: { index: hookFailure.hookIndex, type: hookFailure.hookType } }),
  };
}

function createdLine(preparation: WorkflowRunSummary['preparation']): string {
  return workflowEnvironmentCreatedLine({
    worktree: preparation.worktree,
    surface: preparation.surface,
    ...(preparation.worktree === null
      ? {}
      : { worktreePath: compactHomePath(preparation.worktree.worktreePath) }),
  });
}

/** Blank-line separated paragraphs; the outcome body renders newlines. */
function paragraphs(lines: readonly (string | null)[]): string {
  return lines.filter((line): line is string => Boolean(line)).join('\n\n');
}
