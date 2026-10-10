import assert from 'node:assert/strict';
import test from 'node:test';

import { Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';

import type { ControlPlaneSnapshot, EditorProvisioningState } from '@isagi/contracts';

import { UserVisibleError } from '../../lib/workspace/runtime-data.js';
import { startupBootView } from './startup-view.js';

function snapshot(editorProvisioning: EditorProvisioningState): ControlPlaneSnapshot {
  return {
    onboardingComplete: true,
    configStatus: 'valid',
    configDiagnostic: null,
    policyRevision: 'rev-1',
    inventory: { status: 'ready', generation: 1, environment: 'trusted' },
    harnesses: [],
    reconciliation: {
      desiredFingerprint: null,
      runningFingerprint: null,
      lastCompletedFingerprint: null,
      lastAppliedFingerprint: null,
      lastResult: null,
    },
    editorProvisioning,
  };
}

const failedProvisioning: EditorProvisioningState = {
  status: 'failed',
  version: '1.0.0',
  reason: 'download_failed',
  diagnostic: null,
};

const noop = () => {};
const view = (
  controlPlane: AsyncResult.AsyncResult<ControlPlaneSnapshot, unknown>,
  retryProvisioning: AsyncResult.AsyncResult<unknown, unknown> = AsyncResult.initial(),
) => startupBootView({ controlPlane, retryProvisioning, onRetry: noop, onRetryProvisioning: noop });

test('a pending first read shows connecting, also while it retries', () => {
  assert.deepEqual(view(AsyncResult.initial(true)), { kind: 'connecting' });
});

test('runtime unreachable: retrying mirrors whether a re-read is in flight', () => {
  const failed = AsyncResult.fail<Error, ControlPlaneSnapshot>(
    new UserVisibleError('runtime down'),
  );
  const settled = view(failed);
  assert.equal(settled?.kind, 'runtime_unreachable');
  assert.equal(settled?.kind === 'runtime_unreachable' && settled.retrying, false);
  assert.equal(settled?.kind === 'runtime_unreachable' && settled.error, 'runtime down');

  const rereading = view(AsyncResult.waiting(failed));
  assert.equal(rereading?.kind === 'runtime_unreachable' && rereading.retrying, true);
});

test('a failed refetch over a held snapshot keeps routing on that snapshot', () => {
  const result = AsyncResult.failWithPrevious<ControlPlaneSnapshot, Error>(new Error('down'), {
    previous: Option.some(AsyncResult.success(snapshot({ status: 'not_applicable' }))),
  });
  assert.equal(view(result), null, 'ready: the gate opens');
});

test('editor provisioning: retrying mirrors the retry, and only a settled retry failure shows', () => {
  const failedSnapshot = AsyncResult.success(snapshot(failedProvisioning));

  const idle = view(failedSnapshot);
  assert.equal(idle?.kind, 'editor_provisioning');
  assert.equal(idle?.kind === 'editor_provisioning' && idle.retrying, false);
  assert.equal(idle?.kind === 'editor_provisioning' && idle.retryError, null);

  const running = view(failedSnapshot, AsyncResult.initial(true));
  assert.equal(running?.kind === 'editor_provisioning' && running.retrying, true);

  const refused = AsyncResult.fail(new UserVisibleError('editor provisioning is busy'));
  const afterRefusal = view(failedSnapshot, refused);
  assert.equal(
    afterRefusal?.kind === 'editor_provisioning' && afterRefusal.retryError,
    'editor provisioning is busy',
  );

  // A new retry hides the previous refusal while it runs, as the old mutation cleared its error.
  const rerun = view(failedSnapshot, AsyncResult.waiting(refused));
  assert.equal(rerun?.kind === 'editor_provisioning' && rerun.retryError, null);
  assert.equal(rerun?.kind === 'editor_provisioning' && rerun.retrying, true);
});
