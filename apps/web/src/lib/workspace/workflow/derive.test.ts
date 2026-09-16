import assert from 'node:assert/strict';
import test from 'node:test';

import { workflowCopy } from '../../../copy/index.js';
import { workflowReasonLine, workflowStopNotice } from './derive.js';
import { workflowSummaryFixture } from './test-support.js';

test('a clean stop reports nothing; an incomplete one reports what is actually true', () => {
  assert.equal(workflowStopNotice(workflowSummaryFixture()), null);
  assert.equal(
    workflowStopNotice(
      workflowSummaryFixture({
        stopSummary: { requested: 2, confirmed: 2, failed: 0, unsupported: 0, pending: 0 },
      }),
    ),
    null,
  );
  // Still in flight outranks everything: the stop has not finished, so nothing final can be said.
  assert.equal(
    workflowStopNotice(
      workflowSummaryFixture({
        stopSummary: { requested: 3, confirmed: 1, failed: 1, unsupported: 1, pending: 1 },
      }),
    ),
    workflowCopy.stopPending,
  );
  assert.equal(
    workflowStopNotice(
      workflowSummaryFixture({
        stopSummary: { requested: 2, confirmed: 1, failed: 1, unsupported: 0, pending: 0 },
      }),
    ),
    workflowCopy.stopFailed,
  );
  // Work Isagi has no way to stop stays visible as a limitation rather than a confirmed stop.
  assert.equal(
    workflowStopNotice(
      workflowSummaryFixture({
        stopSummary: { requested: 2, confirmed: 1, failed: 0, unsupported: 1, pending: 0 },
      }),
    ),
    workflowCopy.stopUnsupported,
  );
});

test('the reason line explains what is holding the run, in the order a person can act on', () => {
  assert.equal(workflowReasonLine(workflowSummaryFixture()), null);

  const blocked = workflowSummaryFixture({
    status: 'blocked',
    blockedOperation: { operationKey: 'op-1', frameId: 1, executionId: 1 },
  });
  assert.equal(workflowReasonLine(blocked), workflowCopy.blockedOperation);

  // An unavailable environment outranks it: nothing can proceed until the worktree is back, so
  // pointing at the uncertain operation first would send someone to the wrong problem.
  const parked = workflowSummaryFixture({
    status: 'blocked',
    blockedOperation: { operationKey: 'op-1', frameId: 1, executionId: 1 },
    destination: { ...workflowSummaryFixture().destination, available: false },
  });
  assert.equal(workflowReasonLine(parked), workflowCopy.environmentUnavailable);
});

test('a finished run does not complain about an environment it no longer needs', () => {
  const ended = workflowSummaryFixture({
    status: 'done',
    endedAt: '2026-09-15T10:05:00.000Z',
    destination: { ...workflowSummaryFixture().destination, available: false },
  });
  assert.equal(workflowReasonLine(ended), null);
});
