import { Schema } from 'effect';

import { workflowRejectedErrorSchema } from '@isagi/contracts';

import {
  apiErrorDiagnostic,
  endpointDiagnostic,
  paletteCopy,
  runtimeErrorCopy,
} from '../../copy/index.js';
import { classifyRuntimeFailure } from '../runtime/classify.js';
import type { CommandErrorContent, WorkflowFailurePresentation } from './types.js';

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
  const classified = classifyRuntimeFailure(error);
  const title = paletteCopy.workflows.startFailed.title;
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
