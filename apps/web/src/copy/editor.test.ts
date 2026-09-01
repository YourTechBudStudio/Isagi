import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ApiError,
  EditorAttemptFailureReason,
  EditorProcessDiagnostic,
  EditorProvisioningFailureReason,
  EditorRejectionReason,
} from '@isagi/contracts';

import { runtimeErrorCopy } from './errors.js';
import {
  editorAttemptFailureCopy,
  editorCopy,
  editorProcessDiagnosticCopy,
  editorProvisioningCopy,
  editorSettledCopy,
  editorSettledStatusLabel,
} from './index.js';

const ATTEMPT_REASONS: readonly EditorAttemptFailureReason[] = [
  'port_allocation_failed',
  'session_socket_unavailable',
  'launch_allocation_failed',
  'launch_interrupted',
  'previous_incarnation_not_stopped',
  'launch_target_missing',
];

const DIAGNOSTICS: readonly EditorProcessDiagnostic[] = [
  'launch_failed',
  'attach_failed',
  'process_missing',
  'exited',
  'killed',
];

const PROVISIONING_REASONS: readonly EditorProvisioningFailureReason[] = [
  'unsupported_platform',
  'release_unavailable',
  'download_failed',
  'integrity_mismatch',
  'extract_failed',
  'install_unusable',
];

const editorError = (code: string, data: Record<string, unknown>): ApiError =>
  ({ code, status: 500, message: 'diagnostic message', requestId: 'req-1', data }) as ApiError;

test('every editor reason has a sentence, and none is left to a fallback', () => {
  for (const reason of ATTEMPT_REASONS) {
    assert.ok(editorAttemptFailureCopy[reason].length > 0, reason);
  }
  for (const diagnostic of DIAGNOSTICS) {
    assert.ok(editorProcessDiagnosticCopy[diagnostic].length > 0, diagnostic);
  }
  for (const reason of PROVISIONING_REASONS) {
    assert.ok(editorProvisioningCopy.failure.title[reason].length > 0, reason);
    assert.ok(editorProvisioningCopy.failure.body[reason].length > 0, reason);
    assert.ok(editorProvisioningCopy.failure.manifest[reason].length > 0, reason);
  }
});

test('a launch failure reads identically as a response and as a projection', () => {
  // The pane reads it back from the durable attempt; the palette or pane reads it
  // off the API error. One map feeds both, so the two can never drift.
  for (const reason of ATTEMPT_REASONS) {
    const fromApi = runtimeErrorCopy.fromApiError(
      editorError('editor_launch_failed', { reason, editorContextId: 7 }),
    );
    const fromProjection = editorSettledCopy({ kind: 'attempt_failed', reason });
    assert.equal(fromApi, fromProjection, reason);
    assert.equal(fromApi, editorAttemptFailureCopy[reason], reason);
  }
});

test('every editor rejection reason maps to copy rather than the generic line', () => {
  const reasons: readonly EditorRejectionReason[] = [
    'worktree_not_found',
    'editor_context_not_found',
    'editor_unsupported_runtime',
    'editor_unavailable',
    'editor_provisioning_busy',
    'editor_incarnation_superseded',
  ];
  for (const reason of reasons) {
    const copy = runtimeErrorCopy.fromApiError(editorError('editor_rejected', { reason }));
    assert.notEqual(copy, 'The runtime ran into a problem.', reason);
    assert.notEqual(copy, "Couldn't open the editor.", `${reason} should refine the summary`);
  }
});

test('a failed diagnostics read has its own sentence', () => {
  assert.equal(
    runtimeErrorCopy.fromApiError(editorError('editor_diagnostics_unavailable', {})),
    "Couldn't read the editor's startup output.",
  );
});

test('a settled pane says what settled it, not merely that something did', () => {
  assert.equal(editorSettledStatusLabel({ kind: 'unreachable' }), 'unreachable');
  assert.equal(editorSettledStatusLabel({ kind: 'unknown' }), 'unknown');
  assert.equal(editorSettledStatusLabel({ kind: 'process', diagnostic: 'killed' }), 'killed');
  assert.equal(
    editorSettledStatusLabel({ kind: 'attempt_failed', reason: 'launch_interrupted' }),
    'failed',
  );
});

test('only a genuinely retryable provisioning failure claims to be retryable', () => {
  assert.equal(editorProvisioningCopy.retryable.unsupported_platform, false);
  for (const reason of PROVISIONING_REASONS.filter((r) => r !== 'unsupported_platform')) {
    assert.equal(editorProvisioningCopy.retryable[reason], true, reason);
  }
});

test('the truncation note is stated in units a person reads', () => {
  assert.equal(editorCopy.diagnostics.truncated(512), '… 512 B dropped from the front');
  assert.equal(editorCopy.diagnostics.truncated(41_984), '… 41 KiB dropped from the front');
  assert.equal(editorCopy.diagnostics.truncated(3_145_728), '… 3.0 MiB dropped from the front');
});

test('humour stays out of the failures and the working chrome', () => {
  const failureProse = [
    ...ATTEMPT_REASONS.map((reason) => editorAttemptFailureCopy[reason]),
    ...DIAGNOSTICS.map((diagnostic) => editorProcessDiagnosticCopy[diagnostic]),
    ...PROVISIONING_REASONS.flatMap((reason) => [
      editorProvisioningCopy.failure.title[reason],
      editorProvisioningCopy.failure.body[reason],
    ]),
    ...Object.values(editorProvisioningCopy.status),
    editorCopy.launching,
    editorCopy.waitingForWorkbench,
    editorCopy.frameLoading,
  ];
  for (const line of failureProse) {
    assert.doesNotMatch(line, /[!✨🎉]|hang tight|almost there|just a sec/iu, line);
  }
});
