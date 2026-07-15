import assert from 'node:assert/strict';
import test from 'node:test';

import type { ApiError } from '@isagi/contracts';

import { apiErrorDiagnostic, endpointDiagnostic, runtimeErrorCopy } from './errors.js';

function workflowRejected(data: Record<string, unknown>, requestId = 'req-1'): ApiError {
  return {
    code: 'workflow_rejected',
    status: 500,
    message: 'diagnostic message',
    requestId,
    data,
  } as ApiError;
}

test('workflow_discovery_failed maps to singular source-path copy', () => {
  assert.equal(
    runtimeErrorCopy.fromApiError(
      workflowRejected({
        reason: 'workflow_discovery_failed',
        workflowSourceDirectory: '/roots/x',
      }),
    ),
    "Couldn't read a workflow source path.",
  );
});

test('discovery diagnostic frames the failing source directory above code/request', () => {
  const detail = apiErrorDiagnostic(
    workflowRejected(
      { reason: 'workflow_discovery_failed', workflowSourceDirectory: '/roots/extra' },
      'req-disc',
    ),
  );
  assert.equal(detail, 'Source directory: /roots/extra\n\nworkflow_rejected · request req-disc');
});

test('load-failure diagnostic preserves winner then shadowed order', () => {
  const detail = apiErrorDiagnostic(
    workflowRejected(
      {
        reason: 'workflow_load_failed',
        workflowPackageDirectory: '/winner/release',
        shadowedWorkflowPackageDirectories: ['/lower/release', '/lowest/release'],
      },
      'req-load',
    ),
  );
  assert.equal(
    detail,
    [
      'Workflow package: /winner/release',
      'Shadowed package: /lower/release',
      'Shadowed package: /lowest/release',
      '',
      'workflow_rejected · request req-load',
    ].join('\n'),
  );
});

test('a workflow rejection without path fields degrades to code/request only', () => {
  assert.equal(
    apiErrorDiagnostic(workflowRejected({ reason: 'workflow_surface_busy' }, 'req-busy')),
    'workflow_rejected · request req-busy',
  );
});

test('a non-workflow API error yields only the code/request line', () => {
  const apiError = {
    code: 'runtime_database_failed',
    status: 500,
    message: 'db down',
    requestId: 'req-db',
    data: { operation: 'read' },
  } satisfies ApiError;
  assert.equal(apiErrorDiagnostic(apiError), 'runtime_database_failed · request req-db');
});

test('endpoint diagnostic frames the endpoint identifier', () => {
  assert.equal(endpointDiagnostic('workflows.descriptors'), 'Endpoint: workflows.descriptors');
});
