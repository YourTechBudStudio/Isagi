import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkflowOperationRecord } from '../persistence/records.js';
import { decidePrefix, readRequestEnvelope, requestEnvelope } from './correlation.js';

function record(input: Partial<WorkflowOperationRecord> & { callIndex: number }) {
  return {
    id: input.callIndex + 1,
    operationKey: `wop_${input.callIndex}`,
    runId: 1,
    frameId: 1,
    executionId: 1,
    originAttemptId: 1,
    capability: 'run_headless_agent',
    requestFingerprint: 'fp',
    request: null,
    artifactHash: 'pin',
    state: 'dispatched',
    stage: null,
    receipt: null,
    result: null,
    targetKind: 'none',
    targetId: null,
    ptyProcessId: null,
    captureOwner: null,
    attribution: 'not_applicable',
    correlatedStartSeq: null,
    correlatedHarnessSessionId: null,
    submissionWatermark: null,
    stopState: 'not_requested',
    stopDetail: null,
    stopRequestedAt: null,
    stopSettledAt: null,
    uncertaintyDetail: null,
    lateEvidence: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    dispatchedAt: null,
    settledAt: null,
    ...input,
  } as WorkflowOperationRecord;
}

const ask = (callIndex: number, recorded: readonly WorkflowOperationRecord[]) =>
  decidePrefix({ callIndex, capability: 'run_headless_agent', fingerprint: 'fp', recorded });

test('a new position with an empty prefix dispatches', () => {
  assert.deepEqual(ask(0, []), { kind: 'dispatch', existing: null });
});

test('an outstanding dispatched predecessor does not block a new position', () => {
  // This is the ordinary way an author builds a multi-operation wait: launch judgment B while
  // judgment A is still running. The blocking condition is unresolved *uncertainty*, never
  // outstanding external work, and collapsing the two would make the documented multi-headless
  // pattern impossible to express.
  const decision = ask(1, [record({ callIndex: 0, state: 'dispatched' })]);
  assert.equal(decision.kind, 'dispatch');
});

test('an earlier uncertain operation blocks every later position', () => {
  const decision = ask(1, [record({ callIndex: 0, state: 'uncertain' })]);
  assert.equal(decision.kind, 'prefix_unresolved');
  assert.equal(decision.kind === 'prefix_unresolved' && decision.blocking.callIndex, 0);
});

test('uncertainty at this very position is reported as uncertainty, not as a blocked prefix', () => {
  // Different faults, and an author sees a different message for each: one says "an earlier call has
  // no established outcome", the other says "this call has no established outcome and cannot be
  // retried". Reporting both as a prefix problem would hide which effect is actually unresolved.
  const decision = ask(0, [record({ callIndex: 0, state: 'uncertain' })]);
  assert.equal(decision.kind, 'uncertain');
});

test('a settled operation at this position is reused rather than dispatched again', () => {
  for (const state of ['completed', 'failed', 'interrupted'] as const) {
    const decision = ask(0, [record({ callIndex: 0, state })]);
    assert.equal(decision.kind, 'reuse', `state ${state} must reuse its receipt`);
  }
});

test('intended and abandoned both dispatch under the same operation identity', () => {
  // The same transition reached two ways: at first entry, and through recovery from a position whose
  // effect provably never left. Keeping the existing record is what makes the redispatch the *same*
  // operation rather than a second one.
  for (const state of ['intended', 'abandoned'] as const) {
    const existing = record({ callIndex: 0, state });
    const decision = ask(0, [existing]);
    assert.equal(decision.kind, 'dispatch');
    assert.equal(decision.kind === 'dispatch' && decision.existing?.id, existing.id);
  }
});

test('a changed request or capability at a recorded position is refused before any effect', () => {
  const existing = record({ callIndex: 0, state: 'completed' });
  const changedRequest = decidePrefix({
    callIndex: 0,
    capability: 'run_headless_agent',
    fingerprint: 'different',
    recorded: [existing],
  });
  assert.equal(changedRequest.kind, 'request_changed');

  const changedCapability = decidePrefix({
    callIndex: 0,
    capability: 'send_agent_prompt',
    fingerprint: 'fp',
    recorded: [existing],
  });
  assert.equal(changedCapability.kind, 'request_changed');
});

test('a changed request is refused even when the prefix is otherwise healthy', () => {
  const decision = decidePrefix({
    callIndex: 1,
    capability: 'run_headless_agent',
    fingerprint: 'different',
    recorded: [
      record({ callIndex: 0, state: 'completed' }),
      record({ callIndex: 1, state: 'completed' }),
    ],
  });
  assert.equal(decision.kind, 'request_changed');
});

test('an envelope round-trips, and a malformed one degrades to null rather than throwing', () => {
  const envelope = requestEnvelope({
    request: { capability: 'close_pane', paneId: 4 },
    dispatch: { effectiveTimeoutMs: 1000 },
  });
  assert.deepEqual(readRequestEnvelope(JSON.parse(JSON.stringify(envelope))), {
    request: { capability: 'close_pane', paneId: 4 },
    dispatch: { effectiveTimeoutMs: 1000 },
    metadata: null,
  });
  // An operation whose payload cannot be read still has to be classifiable from its own columns, so
  // this returns null instead of failing recovery for every operation behind it.
  assert.equal(readRequestEnvelope(null), null);
  assert.equal(readRequestEnvelope('not an object'), null);
  assert.equal(readRequestEnvelope({ dispatch: {} }), null);
});

test('inspector metadata rides alongside the request without entering its identity', () => {
  // Modifiers are already folded into the rendered prompt, so recording them adds no hash meaning —
  // it only lets the inspector show what the author wrote instead of only what was sent. The
  // fingerprint is taken over the semantic request, so the envelope around it cannot shift identity.
  const request = {
    capability: 'send_agent_prompt',
    agentSessionId: 7,
    renderedPrompt: '/review please',
  } as const;
  const bare = requestEnvelope({ request });
  const decorated = requestEnvelope({
    request,
    dispatch: { effectiveTimeoutMs: 600_000 },
    metadata: { modifiers: [{ kind: 'skill', name: 'review' }] },
  });

  assert.deepEqual(decorated.request, bare.request, 'the semantic request is untouched');
  assert.deepEqual(decorated.metadata?.modifiers, [{ kind: 'skill', name: 'review' }]);
  assert.equal(bare.metadata, null);

  // And the envelope round-trips, because it is what the inspector reads back.
  assert.deepEqual(readRequestEnvelope(JSON.parse(JSON.stringify(decorated))), decorated);
});
