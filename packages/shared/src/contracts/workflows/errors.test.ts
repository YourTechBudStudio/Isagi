import assert from 'node:assert/strict';
import test from 'node:test';

import { Schema } from 'effect';

import { workflowApiErrorSchema, workflowRejectionReasonSchema } from '../api/errors.js';

/**
 * The expected workflow failures a client is meant to handle. A reason the contract cannot express
 * becomes a response-encoding failure at run time instead of the structured rejection the caller
 * needs.
 */
const decode = (value: unknown) => Schema.decodeUnknownSync(workflowApiErrorSchema)(value);

function rejection(data: Record<string, unknown>) {
  return {
    code: 'workflow_rejected',
    status: 400,
    message: 'The workflow request was rejected.',
    requestId: 'req-1',
    data,
  };
}

const diagnostic = {
  code: 'node_missing',
  message: 'the parked node no longer exists',
  at: { graphKey: 'Story', nodeId: 'askWriter' },
};

test('a refused reload names what no longer fits, as addressable diagnostics', () => {
  const error = decode(
    rejection({
      reason: 'workflow_code_incompatible',
      workflowRunId: 7,
      control: 'retry',
      diagnostics: [diagnostic],
    }),
  );
  const data = (error as { data: { diagnostics?: readonly { at: { nodeId?: string } }[] } }).data;
  assert.equal(data.diagnostics?.[0]?.at.nodeId, 'askWriter');
});

test('mandatory context cannot be omitted', () => {
  assert.throws(() => decode(rejection({ reason: 'workflow_code_incompatible' })));
  assert.throws(() => decode(rejection({ reason: 'workflow_structure_validation_failed' })));
  assert.throws(() =>
    decode(
      rejection({ reason: 'workflow_checkpoint_destination_rejected', destinationPath: '/x' }),
    ),
  );
});

test('removed mechanisms have no reasons left', () => {
  for (const reason of [
    'workflow_payload_unavailable',
    'workflow_evidence_not_found',
    'workflow_operation_uncertain',
    'workflow_version_not_adopted',
    'workflow_stale_control',
    'workflow_cursor_invalid',
  ]) {
    assert.throws(() => decode(rejection({ reason })), `${reason} should be gone`);
  }
});

test('every advertised reason is accepted by the error data', () => {
  const reasons = workflowRejectionReasonSchema.members.flatMap((member) => member.literals);
  assert.ok(reasons.length > 0);
  for (const reason of reasons) {
    const data: Record<string, unknown> = { reason };
    if (
      reason === 'workflow_structure_validation_failed' ||
      reason === 'workflow_code_incompatible'
    )
      data.diagnostics = [diagnostic];
    if (reason === 'workflow_checkpoint_destination_rejected') {
      data.destinationPath = '/tmp/x';
      data.destinationIssue = 'not_empty';
    }
    assert.doesNotThrow(() => decode(rejection(data)), `${reason} is advertised but not accepted`);
  }
});
