import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import type { ApiError } from '@isagi/contracts';

import { paletteCopy, runtimeErrorCopy } from '../../copy/index.js';
import { RuntimeApiError, RuntimeDecodeError, RuntimeTransportError } from '../runtime/client.js';
import { workflowFailurePresentation, workflowStartFailureContent } from './workflow-failure.js';

const failure = paletteCopy.workflows.failure;

function workflowRejected(data: Record<string, unknown>, requestId = 'req-1'): ApiError {
  return {
    code: 'workflow_rejected',
    status: 500,
    message: 'diagnostic message',
    requestId,
    data,
  } as ApiError;
}

const dbError = {
  code: 'runtime_database_failed',
  status: 500,
  message: 'db down',
  requestId: 'req-db',
  data: { operation: 'read' },
} satisfies ApiError;

test('a source-scan rejection becomes the discovery presentation with a framed source path', () => {
  const presentation = workflowFailurePresentation(
    new RuntimeApiError(
      workflowRejected(
        { reason: 'workflow_discovery_failed', workflowSourceDirectory: '/roots/extra' },
        'req-disc',
      ),
    ),
  );

  assert.equal(presentation.label, failure.discovery.label);
  assert.equal(presentation.sub, failure.discovery.sub);
  assert.equal(presentation.content.title, failure.discovery.title);
  assert.equal(presentation.content.body, failure.discovery.body);
  assert.equal(presentation.content.diagnostic?.label, failure.diagnosticLabel);
  assert.ok(presentation.content.diagnostic?.detail.includes('Source directory: /roots/extra'));
  assert.ok(presentation.content.diagnostic?.detail.includes('request req-disc'));
});

test('discovery classification unwraps an Effect fiber failure', async () => {
  const wrapped = await Effect.runPromise(
    Effect.fail(
      new RuntimeApiError(
        workflowRejected({ reason: 'workflow_discovery_failed', workflowSourceDirectory: '/r' }),
      ),
    ),
  ).catch((cause: unknown) => cause);
  assert.equal(workflowFailurePresentation(wrapped).content.title, failure.discovery.title);
});

test('a non-discovery workflow rejection uses generic chrome with reason-specific body', () => {
  const apiError = workflowRejected({ reason: 'workflow_surface_busy' }, 'req-busy');
  const presentation = workflowFailurePresentation(new RuntimeApiError(apiError));

  assert.equal(presentation.label, failure.generic.label);
  assert.equal(presentation.content.title, failure.generic.title);
  assert.equal(presentation.content.body, runtimeErrorCopy.fromApiError(apiError));
  assert.notEqual(presentation.content.body, failure.generic.body);
  assert.equal(presentation.content.diagnostic?.detail, 'workflow_rejected · request req-busy');
});

test('a non-workflow API error uses generic chrome with a code/request diagnostic', () => {
  const presentation = workflowFailurePresentation(new RuntimeApiError(dbError));
  assert.equal(presentation.content.body, runtimeErrorCopy.fromApiError(dbError));
  assert.equal(presentation.content.diagnostic?.detail, 'runtime_database_failed · request req-db');
});

test('a transport failure is generic with transport body and no diagnostic', () => {
  const presentation = workflowFailurePresentation(new RuntimeTransportError('down', null));
  assert.equal(presentation.content.body, runtimeErrorCopy.transport);
  assert.equal(presentation.content.diagnostic, undefined);
});

test('a decode failure frames the endpoint as diagnostic evidence', () => {
  const presentation = workflowFailurePresentation(
    new RuntimeDecodeError('workflows.descriptors', null),
  );
  assert.equal(presentation.content.body, runtimeErrorCopy.decode);
  assert.equal(presentation.content.diagnostic?.detail, 'Endpoint: workflows.descriptors');
});

test('an unexpected failure invents no scan cause and no diagnostic', () => {
  const presentation = workflowFailurePresentation(new Error('boom'));
  assert.equal(presentation.content.body, failure.generic.body);
  assert.equal(presentation.content.diagnostic, undefined);
});

test('start failure keeps structured paths for API errors', () => {
  const apiError = workflowRejected(
    {
      reason: 'workflow_load_failed',
      workflowLoadFailureReason: 'artifact_tampered',
      workflowPackageDirectory: '/winner/release',
      shadowedWorkflowPackageDirectories: ['/lower/release'],
    },
    'req-start',
  );
  const content = workflowStartFailureContent(new RuntimeApiError(apiError));

  assert.equal(content.title, paletteCopy.workflows.startFailed.title);
  assert.equal(content.body, runtimeErrorCopy.fromApiError(apiError));
  assert.equal(content.diagnostic?.label, paletteCopy.workflows.startFailed.diagnosticLabel);
  assert.ok(content.diagnostic?.detail.includes('Workflow package: /winner/release'));
  assert.ok(content.diagnostic?.detail.includes('Shadowed package: /lower/release'));
  assert.ok(content.diagnostic?.detail.includes('request req-start'));
});

test('start failure omits the diagnostic for transport and unknown, frames endpoint for decode', () => {
  const transport = workflowStartFailureContent(new RuntimeTransportError('down', null));
  assert.equal(transport.body, runtimeErrorCopy.transport);
  assert.equal(transport.diagnostic, undefined);

  const unknown = workflowStartFailureContent(new Error('boom'));
  assert.equal(unknown.body, runtimeErrorCopy.unknown);
  assert.equal(unknown.diagnostic, undefined);

  const decode = workflowStartFailureContent(new RuntimeDecodeError('workflows.start', null));
  assert.equal(decode.body, runtimeErrorCopy.decode);
  assert.equal(decode.diagnostic?.detail, 'Endpoint: workflows.start');
});
