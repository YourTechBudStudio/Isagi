import assert from 'node:assert/strict';
import test from 'node:test';

import { Schema } from 'effect';

import { workflowApiErrorSchema, workflowRejectionReasonSchema } from '../api/errors.js';

/**
 * The expected workflow failures a client is meant to handle.
 *
 * These matter because a reason the contract cannot express becomes a response-encoding failure at
 * run time rather than the explicit, structured rejection the caller needs.
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

test('every v2 rejection reason that needs no mandatory context is expressible', () => {
  for (const reason of [
    'unknown_workflow_key',
    'workflow_discovery_failed',
    'workflow_load_failed',
    'no_active_worktree',
    'worktree_not_found',
    'surface_not_found',
    'surface_worktree_mismatch',
    'pane_not_found',
    'agent_session_not_on_surface',
    'workflow_launch_context_mismatch',
    'workflow_command_failed',
    'workflow_inputs_rejected',
    'workflow_root_surface_required',
    'workflow_surface_attached',
    'workflow_run_not_found',
    'workflow_run_not_retryable',
    'workflow_run_not_cancellable',
    'workflow_wait_not_found',
    'workflow_wait_already_resolved',
    'workflow_user_input_invalid',
    'workflow_version_not_adopted',
    'workflow_operation_uncertain',
    'workflow_stale_control',
    'workflow_environment_unavailable',
  ]) {
    assert.doesNotThrow(() => decode(rejection({ reason })), reason);
  }
});

test('the v1 reasons whose mechanisms were removed are gone', () => {
  for (const reason of [
    'validation_failed',
    'workflow_root_run_required',
    'workflow_surface_busy',
    'workflow_run_not_failed',
    'workflow_wait_not_satisfiable',
    'workflow_event_ledger_failed',
  ]) {
    assert.throws(() => decode(rejection({ reason })), reason);
  }
});

test('a structural rejection carries addressable diagnostics, not one sentence', () => {
  const error = decode(
    rejection({
      reason: 'workflow_structure_validation_failed',
      workflowKey: 'reviewed-document',
      diagnostics: [
        {
          code: 'destination_no_longer_declared',
          message: 'the saved destination is no longer declared',
          at: { graphKey: 'Story', edgeId: 'fromAskWriter' },
        },
      ],
    }),
  );
  const data = (error as { data: { diagnostics?: readonly { at: { edgeId?: string } }[] } }).data;
  assert.equal(data.diagnostics?.[0]?.at.edgeId, 'fromAskWriter');
});

test('an unavailable payload names the reference and why, and both survive decoding', () => {
  const error = decode(
    rejection({
      reason: 'workflow_payload_unavailable',
      workflowRunId: 1,
      payloadRef: 'sha256:abc',
      cause: 'corrupt',
    }),
  );
  const data = (error as { data: { payloadRef?: string; cause?: string } }).data;
  assert.equal(data.payloadRef, 'sha256:abc');
  assert.equal(data.cause, 'corrupt');
});

test('mandatory failure context cannot be omitted or invented', () => {
  // A reason alone leaves the inspector nothing to render, which is the whole point of the
  // structured error. Both of these were accepted when the fields were merely optional.
  assert.throws(() => decode(rejection({ reason: 'workflow_payload_unavailable' })));
  assert.throws(() =>
    decode(rejection({ reason: 'workflow_payload_unavailable', payloadRef: 'sha256:abc' })),
  );
  assert.throws(() =>
    decode(
      rejection({
        reason: 'workflow_payload_unavailable',
        payloadRef: 'sha256:abc',
        cause: 'stale',
      }),
    ),
  );
  assert.throws(() => decode(rejection({ reason: 'workflow_structure_validation_failed' })));
});

test('a stale control, an unadopted version and an uncertain operation each carry their context', () => {
  assert.doesNotThrow(() =>
    decode(rejection({ reason: 'workflow_stale_control', workflowRunId: 1 })),
  );
  assert.doesNotThrow(() =>
    decode(rejection({ reason: 'workflow_version_not_adopted', artifactHash: 'sha256:pin9' })),
  );
  assert.doesNotThrow(() =>
    decode(rejection({ reason: 'workflow_operation_uncertain', operationKey: 'wop_1' })),
  );
});

test('an environment-unavailable rejection is expressible for a run whose placement is gone', () => {
  assert.doesNotThrow(() =>
    decode(
      rejection({ reason: 'workflow_environment_unavailable', workflowRunId: 1, worktreeId: 3 }),
    ),
  );
});

test('the exported reason set cannot drift from the set the error data accepts', () => {
  // Two independently maintained lists would let a reason be advertised that the error schema
  // rejects. The exported union is derived from the same two sets the data variants use, so this
  // asserts they agree for every reason rather than trusting the declarations to stay in step.
  const reasons = Schema.decodeUnknownSync(Schema.Array(workflowRejectionReasonSchema));
  const every = reasons([
    'unknown_workflow_key',
    'workflow_discovery_failed',
    'workflow_load_failed',
    'no_active_worktree',
    'worktree_not_found',
    'surface_not_found',
    'surface_worktree_mismatch',
    'pane_not_found',
    'agent_session_not_on_surface',
    'workflow_launch_context_mismatch',
    'workflow_command_failed',
    'workflow_inputs_rejected',
    'workflow_root_surface_required',
    'workflow_surface_attached',
    'workflow_run_not_found',
    'workflow_run_not_retryable',
    'workflow_run_not_cancellable',
    'workflow_wait_not_found',
    'workflow_wait_already_resolved',
    'workflow_user_input_invalid',
    'workflow_structure_validation_failed',
    'workflow_version_not_adopted',
    'workflow_payload_unavailable',
    'workflow_operation_uncertain',
    'workflow_stale_control',
    'workflow_environment_unavailable',
  ]);
  assert.equal(every.length, 26);

  for (const reason of every) {
    const data: Record<string, unknown> = { reason };
    if (reason === 'workflow_structure_validation_failed') data.diagnostics = [];
    if (reason === 'workflow_payload_unavailable') {
      data.payloadRef = 'sha256:abc';
      data.cause = 'missing';
    }
    assert.doesNotThrow(() => decode(rejection(data)), `${reason} is advertised but not accepted`);
  }
});
