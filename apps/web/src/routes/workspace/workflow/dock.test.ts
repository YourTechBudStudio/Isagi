import assert from 'node:assert/strict';
import test from 'node:test';

import {
  workflowFrameFixture,
  workflowOperationFixture,
} from '../../../lib/workspace/workflow/test-support.js';
import { inspectorCopy } from './copy.js';
import {
  buildDockView,
  operationDataTabs,
  operationTabKey,
  shortHash,
  type DockRow,
} from './dock.js';
import {
  clockAt,
  descriptorFixture,
  graphFixture,
  instant,
  nested,
  rootFrame,
  runStateFixture,
  visit,
} from './test-support.js';
import { buildTopology } from './topology.js';

/**
 * The dock's honesty rules, as tests rather than as intentions.
 */

const now = clockAt(120);

const currentPin = buildTopology(
  descriptorFixture(
    [
      graphFixture({
        key: 'root',
        entry: 'writer',
        nodes: [
          { id: 'writer', kind: 'operation' },
          { id: 'reviewer', kind: 'subgraph', graphKey: 'review' },
        ],
        edges: [
          { id: 'after-writer', from: 'writer', to: ['reviewer'] },
          { id: 'after-reviewer', from: 'reviewer', to: ['shipped'] },
        ],
        outcomes: [{ id: 'shipped', kind: 'success' }],
      }),
      graphFixture({
        key: 'review',
        entry: 'read',
        nodes: [{ id: 'read', kind: 'operation' }],
        edges: [{ id: 'done', from: 'read', to: ['ok'] }],
        outcomes: [{ id: 'ok', kind: 'success' }],
      }),
    ],
    'root',
  ),
);

const fields = (rows: readonly DockRow[]) =>
  rows.filter((row): row is Exclude<DockRow, { gap: true }> => !('gap' in row));

const valueOf = (rows: readonly DockRow[], label: string) =>
  fields(rows).find((row) => row.label === label)?.value;

test('a node the current pin no longer declares says so, and never borrows a declaration', () => {
  const state = runStateFixture({
    executions: [visit({ executionId: 1, nodeId: 'retired-node', status: 'completed' })],
  });

  const view = buildDockView({
    selection: { kind: 'execution', executionId: 1 },
    state,
    topology: currentPin,
    now,
  });

  assert.equal(valueOf(view!.declared, 'declared'), inspectorCopy.absentFromCurrentPin);
  // Recorded stays fully usable: the visit happened, and history is what Trace is for.
  assert.equal(valueOf(view!.recorded, 'execution'), '1');
  assert.equal(
    fields(view!.declared).some((row) => row.label === 'id' && row.value === 'writer'),
    false,
    "another node's declaration must never stand in for the missing one",
  );
});

test('a human wait keeps the operation cards instead of replacing them', () => {
  const state = runStateFixture({
    executions: [
      visit({
        executionId: 1,
        nodeId: 'writer',
        status: 'awaiting',
        operationSummary: {
          count: 2,
          unresolved: 0,
          evidenceCaptured: 0,
          capabilities: ['send_agent_prompt'],
        },
        wait: {
          waitId: 9,
          kind: 'user_input',
          status: 'armed',
          label: null,
          questions: [{ kind: 'text', key: 'why', label: 'Why?' }],
          answers: null,
          armedAt: instant(5),
          deliveredAt: null,
        },
      }),
    ],
  });

  const view = buildDockView({
    selection: { kind: 'execution', executionId: 1 },
    state,
    topology: currentPin,
    now,
  });

  assert.equal(view!.operations.kind, 'wait_and_operations');
  assert.equal(view!.executionId, 1, 'the operations column still has an execution to read for');
  if (view!.operations.kind === 'wait_and_operations') {
    assert.equal(valueOf(view!.operations.waitFields, 'wait id'), '#9');
    assert.equal(valueOf(view!.operations.waitFields, 'answered'), inspectorCopy.waitOpen);
    assert.equal(valueOf(view!.operations.waitFields, 'answer in'), inspectorCopy.answerInTheBar);
  }
});

test('an edge and an outcome say they cannot call capabilities', () => {
  const state = runStateFixture({
    executions: [
      visit({
        executionId: 1,
        nodeId: 'writer',
        routing: {
          edgeId: 'after-writer',
          attemptIndex: 1,
          chosen: 'reviewer',
          updateRef: null,
          startedAt: instant(2),
          endedAt: instant(2),
          failure: null,
        },
      }),
    ],
  });

  const routing = buildDockView({
    selection: { kind: 'routing', executionId: 1 },
    state,
    topology: currentPin,
    now,
  });
  assert.equal(routing!.operations.kind, 'none');
  if (routing!.operations.kind === 'none') {
    assert.equal(routing!.operations.reason, inspectorCopy.edgesCannotCall);
  }
  // The segment is addressed by the execution that ran it — no synthesized node-execution id.
  assert.equal(valueOf(routing!.recorded, 'segment'), 'routing · execution 1');
  assert.equal(valueOf(routing!.recorded, 'chose'), 'reviewer');
});

test('attempts are summarized, and a repaired step still explains what went wrong', () => {
  const state = runStateFixture({
    executions: [
      visit({
        executionId: 1,
        nodeId: 'writer',
        status: 'completed',
        attemptCount: 2,
        firstArtifactHash: 'sha256:aaaaaaa1',
        latestArtifactHash: 'sha256:bbbbbbb2',
        latestAttempt: {
          attemptId: 2,
          attemptIndex: 2,
          artifactHash: 'sha256:bbbbbbb2',
          status: 'succeeded',
          invocationKind: 'retry',
          failure: null,
          recoveryMode: 'reuse_producer_output',
          producerArtifactHash: 'sha256:aaaaaaa1',
        },
        priorFailures: [
          {
            attemptId: 1,
            attemptIndex: 1,
            segmentKind: 'node_callback',
            artifactHash: 'sha256:aaaaaaa1',
            failure: { code: 'reduction_failed', message: 'field refused', detail: null },
            repairedByAttemptIndex: 2,
            repairedByArtifactHash: 'sha256:bbbbbbb2',
          },
        ],
      }),
    ],
  });

  const view = buildDockView({
    selection: { kind: 'execution', executionId: 1 },
    state,
    topology: currentPin,
    now,
  });

  assert.equal(valueOf(view!.recorded, 'attempt'), '2 of 2 · latest shown');
  assert.equal(view!.statusChip, 'repaired');
  // A visit that started under one pin and was repaired under another reads as first → latest.
  assert.equal(
    valueOf(view!.recorded, 'pin'),
    'aaaaaaa → bbbbbbb',
    'the digest identifies the pin; the algorithm prefix every hash shares does not',
  );
  assert.match(valueOf(view!.recorded, 'attempt 1') ?? '', /field refused/);
  assert.match(valueOf(view!.recorded, 'repaired by') ?? '', /attempt 2/);
  assert.match(valueOf(view!.recorded, 'recovery') ?? '', /replayed/);
});

test('a frame whose entry threw is inspectable through the frame, with no execution to hang from', () => {
  const state = runStateFixture({
    frames: [
      workflowFrameFixture({
        frameId: 1,
        // A frame whose setup threw never became active; there is no `failed` frame status, and
        // the failure lives on the entry segment where it actually happened.
        status: 'initializing',
        entry: {
          segmentKind: 'graph_entry',
          segmentRef: null,
          attemptCount: 1,
          startedAt: instant(0),
          endedAt: instant(1),
          endCertainty: 'observed',
          firstArtifactHash: 'sha256:pin-1',
          latestArtifactHash: 'sha256:pin-1',
          latestAttempt: {
            attemptId: 1,
            attemptIndex: 1,
            artifactHash: 'sha256:pin-1',
            status: 'failed',
            invocationKind: 'initial',
            failure: { code: 'graph_init_failed', message: 'init threw', detail: null },
            recoveryMode: 'rerun_producer',
            producerArtifactHash: null,
          },
          priorFailures: [],
        },
      }),
    ],
    executions: [],
  });

  const view = buildDockView({
    selection: { kind: 'frame_segment', frameId: 1, segment: 'entry' },
    state,
    topology: currentPin,
    now,
  });

  assert.equal(view!.kindChip, 'graph entry');
  assert.equal(valueOf(view!.recorded, 'message'), 'init threw');
  assert.equal(valueOf(view!.recorded, 'status'), 'failed');
});

test('a frame segment that was never attempted is distinguishable from one that failed', () => {
  const state = runStateFixture({ frames: [rootFrame()], executions: [] });
  const view = buildDockView({
    selection: { kind: 'frame_segment', frameId: 1, segment: 'output' },
    state,
    topology: currentPin,
    now,
  });
  assert.equal(view!.statusChip, inspectorCopy.notAttempted);
});

test('a produced value, an absent one and a JSON null are three different tabs', () => {
  const state = runStateFixture({
    executions: [
      visit({
        executionId: 1,
        nodeId: 'writer',
        status: 'completed',
        stateInRef: { payloadRef: 'p:1', byteSize: 120, mediaType: 'application/json' },
        // The step produced JSON `null`, which is a value it produced.
        candidateRef: { inline: null },
        // The step never produced an update at all.
        updateRef: null,
        stateOutRef: { inline: { draft: '' } },
      }),
    ],
  });

  const view = buildDockView({
    selection: { kind: 'execution', executionId: 1 },
    state,
    topology: currentPin,
    now,
  });

  const tabs = new Map(view!.data.map((tab) => [tab.name, tab.slot]));
  assert.deepEqual(tabs.get('candidate'), { inline: null });
  assert.equal(tabs.get('update'), null);
  assert.deepEqual(tabs.get('state.in'), {
    payloadRef: 'p:1',
    byteSize: 120,
    mediaType: 'application/json',
  });
});

test('a subgraph reports its nested totals rather than inventing operations of its own', () => {
  const state = runStateFixture({
    frames: [
      rootFrame(),
      nested({ frameId: 2, parentExecutionId: 1, parentFrameId: 1, graphKey: 'review', depth: 1 }),
    ],
    executions: [
      visit({
        executionId: 1,
        nodeId: 'reviewer',
        nodeKind: 'subgraph',
        childFrameId: 2,
        childFrame: workflowFrameFixture({
          frameId: 2,
          parentExecutionId: 1,
          parentFrameId: 1,
          graphKey: 'review',
          depth: 1,
          executionCount: 3,
        }),
      }),
      visit({
        executionId: 2,
        frameId: 2,
        graphKey: 'review',
        nodeId: 'read',
        operationSummary: {
          count: 4,
          unresolved: 1,
          evidenceCaptured: 0,
          capabilities: ['send_agent_prompt'],
        },
      }),
    ],
  });

  const view = buildDockView({
    selection: { kind: 'execution', executionId: 1 },
    state,
    topology: currentPin,
    now,
  });

  assert.equal(view!.operations.kind, 'none');
  assert.equal(view!.nested?.entered, true);
  assert.equal(view!.nested?.executions, 3);
  assert.equal(view!.nested?.operations, 4);
  // Declared names the mapping callbacks as roles and does not claim to know their fields.
  assert.equal(valueOf(view!.declared, 'parameters'), inspectorCopy.parametersRole);
  assert.equal(valueOf(view!.declared, 'output'), inspectorCopy.outputMappingRole);
});

test('a label capture failure is a diagnostic about a name, not a failed step', () => {
  const state = runStateFixture({
    executions: [
      visit({
        executionId: 1,
        nodeId: 'writer',
        status: 'completed',
        displayName: null,
        labelDiagnostic: 'label callback threw',
      }),
    ],
  });
  const view = buildDockView({
    selection: { kind: 'execution', executionId: 1 },
    state,
    topology: currentPin,
    now,
  });
  assert.match(valueOf(view!.recorded, 'label') ?? '', /the step still ran/);
  assert.equal(view!.statusChip, 'completed');
});

test('a shortened pin drops the algorithm prefix rather than the digest', () => {
  assert.equal(shortHash('sha256:0f2c1abdeadbeef'), '0f2c1ab');
  assert.equal(shortHash('0f2c1abdeadbeef'), '0f2c1ab');
});

/**
 * Operation payloads, and the subgraph's way in.
 */

test('an operation contributes a tab for every payload it actually produced, and no others', () => {
  const tabs = operationDataTabs([
    workflowOperationFixture({
      operationKey: 'op-a',
      callIndex: 0,
      requestRef: { payloadRef: 'p:req', byteSize: 2_180, mediaType: 'text/plain' },
      receiptRef: { inline: { turnId: 't-88' } },
      // Produced JSON `null` — a value the operation produced, not an absent one.
      resultRef: { inline: null },
      lateEvidenceRef: null,
    }),
    workflowOperationFixture({
      operationKey: 'op-b',
      callIndex: 1,
      receiptRef: null,
      resultRef: null,
      lateEvidenceRef: { inline: { turnId: 't-late' } },
    }),
  ]);

  assert.deepEqual(
    tabs.map((tab) => tab.name),
    ['op1.request', 'op1.receipt', 'op1.result', 'op2.request', 'op2.lateEvidence'],
    'a never-produced slot gets no tab at all',
  );
  // Named by call position, keyed by the operation that made the call.
  assert.deepEqual(
    tabs.map((tab) => tab.key),
    [
      operationTabKey('op-a', 'request'),
      operationTabKey('op-a', 'receipt'),
      operationTabKey('op-a', 'result'),
      operationTabKey('op-b', 'request'),
      operationTabKey('op-b', 'lateEvidence'),
    ],
  );
  // A recorded null is still selectable and still a value.
  assert.deepEqual(tabs[2]?.slot, { inline: null });
  // A stored request keeps its reference and size, so nothing is fetched to show a tab.
  assert.deepEqual(tabs[0]?.slot, {
    payloadRef: 'p:req',
    byteSize: 2_180,
    mediaType: 'text/plain',
  });
});

test('a subgraph lists the child frame’s direct executions, not its descendants', () => {
  const state = runStateFixture({
    frames: [
      rootFrame(),
      nested({ frameId: 2, parentExecutionId: 1, parentFrameId: 1, graphKey: 'review', depth: 1 }),
      nested({ frameId: 3, parentExecutionId: 3, parentFrameId: 2, graphKey: 'rules', depth: 2 }),
    ],
    executions: [
      visit({
        executionId: 1,
        nodeId: 'reviewer',
        nodeKind: 'subgraph',
        childFrameId: 2,
        childFrame: workflowFrameFixture({
          frameId: 2,
          parentExecutionId: 1,
          parentFrameId: 1,
          graphKey: 'review',
          depth: 1,
          executionCount: 2,
        }),
      }),
      visit({
        executionId: 2,
        frameId: 2,
        nodeId: 'read',
        startedAt: instant(1),
        status: 'completed',
      }),
      visit({
        executionId: 3,
        frameId: 2,
        nodeId: 'deep-check',
        nodeKind: 'subgraph',
        childFrameId: 3,
        startedAt: instant(2),
      }),
      // A grandchild: reachable by selecting `deep-check`, never listed here.
      visit({ executionId: 4, frameId: 3, nodeId: 'scan', startedAt: instant(3) }),
    ],
  });

  const view = buildDockView({
    selection: { kind: 'execution', executionId: 1 },
    state,
    topology: currentPin,
    now,
  });

  assert.equal(view!.nested?.entered, true);
  assert.deepEqual(
    view!.nested?.children.map((child) => child.executionId),
    [2, 3],
    'direct children only; a nested subgraph is selected in turn rather than flattened',
  );
  assert.deepEqual(
    view!.nested?.children.map((child) => child.selection),
    [
      { kind: 'execution', executionId: 2 },
      { kind: 'execution', executionId: 3 },
    ],
  );
  assert.equal(view!.nested?.children[1]?.isSubgraph, true);
});

test('a subgraph that has not opened its graph says so rather than showing an empty one', () => {
  const state = runStateFixture({
    executions: [
      visit({ executionId: 1, nodeId: 'reviewer', nodeKind: 'subgraph', childFrameId: null }),
    ],
  });
  const view = buildDockView({
    selection: { kind: 'execution', executionId: 1 },
    state,
    topology: currentPin,
    now,
  });
  assert.equal(view!.nested?.entered, false);
  assert.deepEqual(view!.nested?.children, []);
  assert.equal(view!.nested?.executions, 0);
});
