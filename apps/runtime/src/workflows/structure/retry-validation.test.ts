import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  GraphDescriptor,
  WorkflowStructureDescriptor,
} from '@yourtechbudstudio/isagi-workflow-verifier/structure';

import type { WorkflowRunPosition } from '@isagi/contracts';

import type { WorkflowExecutionRecord, WorkflowFrameRecord } from '../persistence/records.js';
import { validateSavedPositions } from './retry-validation.js';

const PIN = 'a'.repeat(64);

function graph(overrides: Partial<GraphDescriptor> & { key: string }): GraphDescriptor {
  return {
    title: overrides.key,
    stateFields: ['count'],
    entry: 'work',
    nodes: [{ id: 'work', kind: 'operation' }],
    edges: [{ id: 'work-out', from: 'work', to: ['finished'] }],
    outcomes: [{ id: 'finished', kind: 'success' }],
    ...overrides,
  };
}

function descriptor(graphs: readonly GraphDescriptor[]): WorkflowStructureDescriptor {
  return {
    descriptorVersion: 1,
    workflowContractVersion: 3,
    rootGraphKey: graphs[0]!.key,
    graphs,
  };
}

function frame(overrides: Partial<WorkflowFrameRecord> & { id: number }): WorkflowFrameRecord {
  return {
    runId: 1,
    parentExecutionId: null,
    graphKey: 'root',
    entryArtifactHash: PIN,
    depth: 0,
    status: 'active',
    displayName: null,
    parameters: null,
    state: null,
    outcomeId: null,
    outcomeKind: null,
    outcomeReason: null,
    output: null,
    outputArtifactHash: null,
    enteredAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    ...overrides,
  };
}

function execution(
  overrides: Partial<WorkflowExecutionRecord> & { id: number },
): WorkflowExecutionRecord {
  return {
    runId: 1,
    frameId: 1,
    nodeId: 'work',
    nodeKind: 'operation',
    visitIndex: 0,
    status: 'running',
    childFrameId: null,
    displayName: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: null,
    endCertainty: 'observed',
    ...overrides,
  };
}

const rootFrame = frame({ id: 1 });
const workExecution = execution({ id: 1 });

function codes(diagnostics: readonly { readonly code: string }[]) {
  return diagnostics.map((diagnostic) => diagnostic.code);
}

test('an unchanged structure accepts every position kind', () => {
  const structure = descriptor([graph({ key: 'root' })]);
  const positions: readonly WorkflowRunPosition[] = [
    { kind: 'graph_entry', frameId: 1 },
    { kind: 'node_callback', frameId: 1, executionId: 1 },
    { kind: 'awaiting_wait', frameId: 1, executionId: 1, waitId: 1 },
    { kind: 'routing', frameId: 1, executionId: 1, edgeId: 'work-out' },
    { kind: 'graph_output', frameId: 1, outcomeId: 'finished' },
    { kind: 'terminal' },
  ];
  for (const position of positions) {
    assert.deepEqual(
      validateSavedPositions({
        descriptor: structure,
        frames: [rootFrame],
        position,
        execution: workExecution,
      }),
      [],
      `for ${position.kind}`,
    );
  }
});

test('a graph the run is sitting in must still be declared', () => {
  assert.deepEqual(
    codes(
      validateSavedPositions({
        descriptor: descriptor([graph({ key: 'something-else' })]),
        frames: [rootFrame],
        position: { kind: 'graph_entry', frameId: 1 },
      }),
    ),
    ['graph_missing'],
  );
});

test('the node a run is parked on must survive, with its kind', () => {
  const removed = validateSavedPositions({
    descriptor: descriptor([
      graph({ key: 'root', nodes: [{ id: 'other', kind: 'operation' }], entry: 'other' }),
    ]),
    frames: [rootFrame],
    position: { kind: 'node_callback', frameId: 1, executionId: 1 },
    execution: workExecution,
  });
  assert.deepEqual(codes(removed), ['node_missing']);

  const retyped = validateSavedPositions({
    descriptor: descriptor([
      graph({ key: 'root', nodes: [{ id: 'work', kind: 'subgraph', graphKey: 'child' }] }),
      graph({ key: 'child' }),
    ]),
    frames: [rootFrame],
    position: { kind: 'node_callback', frameId: 1, executionId: 1 },
    execution: workExecution,
  });
  assert.deepEqual(codes(retyped), ['node_kind_changed']);
});

test('a routing position needs the same edge identity, and keeps an already-chosen destination', () => {
  const renamed = validateSavedPositions({
    descriptor: descriptor([
      graph({ key: 'root', edges: [{ id: 'renamed', from: 'work', to: ['finished'] }] }),
    ]),
    frames: [rootFrame],
    position: { kind: 'routing', frameId: 1, executionId: 1, edgeId: 'work-out' },
    execution: workExecution,
  });
  assert.deepEqual(codes(renamed), ['edge_identity_changed']);

  // The destination was accepted and its reduction has not committed yet. Retrying under a pin that
  // no longer declares it would let the run commit a route the author removed.
  const droppedDestination = validateSavedPositions({
    descriptor: descriptor([graph({ key: 'root' })]),
    frames: [rootFrame],
    position: { kind: 'routing', frameId: 1, executionId: 1, edgeId: 'work-out' },
    execution: workExecution,
    pendingDestination: 'retired-outcome',
  });
  assert.deepEqual(codes(droppedDestination), ['destination_no_longer_declared']);

  const stillDeclared = validateSavedPositions({
    descriptor: descriptor([graph({ key: 'root' })]),
    frames: [rootFrame],
    position: { kind: 'routing', frameId: 1, executionId: 1, edgeId: 'work-out' },
    execution: workExecution,
    pendingDestination: 'finished',
  });
  assert.deepEqual(stillDeclared, []);
});

test('an outcome a run is evaluating must still be declared', () => {
  assert.deepEqual(
    codes(
      validateSavedPositions({
        descriptor: descriptor([
          graph({ key: 'root', outcomes: [{ id: 'other', kind: 'success' }] }),
        ]),
        frames: [rootFrame],
        position: { kind: 'graph_output', frameId: 1, outcomeId: 'finished' },
      }),
    ),
    ['outcome_missing'],
  );
});

test('a child frame needs its parent to still register that graph', () => {
  const parentExecution = execution({
    id: 5,
    nodeId: 'callChild',
    nodeKind: 'subgraph',
    frameId: 1,
  });
  const childFrame = frame({ id: 2, graphKey: 'child', depth: 1, parentExecutionId: 5 });
  const frames = [frame({ id: 1, graphKey: 'root' }), childFrame];
  const parents = new Map([[5, parentExecution]]);

  const registered = validateSavedPositions({
    descriptor: descriptor([
      graph({
        key: 'root',
        nodes: [{ id: 'callChild', kind: 'subgraph', graphKey: 'child' }],
        entry: 'callChild',
        edges: [{ id: 'child-out', from: 'callChild', to: ['finished'] }],
      }),
      graph({ key: 'child' }),
    ]),
    frames,
    position: { kind: 'graph_entry', frameId: 2 },
    parentExecutions: parents,
  });
  assert.deepEqual(registered, []);

  // The parent now invokes a *different* graph through that node, so the open child frame has no
  // parent to return its output to.
  const repointed = validateSavedPositions({
    descriptor: descriptor([
      graph({
        key: 'root',
        nodes: [{ id: 'callChild', kind: 'subgraph', graphKey: 'other' }],
        entry: 'callChild',
        edges: [{ id: 'child-out', from: 'callChild', to: ['finished'] }],
      }),
      graph({ key: 'child' }),
      graph({ key: 'other' }),
    ]),
    frames,
    position: { kind: 'graph_entry', frameId: 2 },
    parentExecutions: parents,
  });
  assert.deepEqual(codes(repointed), ['subgraph_registration_changed']);
});

test('a completed child awaiting mapping needs its parent node to still be a subgraph', () => {
  const parentExecution = execution({
    id: 5,
    nodeId: 'callChild',
    nodeKind: 'subgraph',
    frameId: 1,
  });
  assert.deepEqual(
    codes(
      validateSavedPositions({
        descriptor: descriptor([
          graph({
            key: 'root',
            nodes: [{ id: 'callChild', kind: 'operation' }],
            entry: 'callChild',
            edges: [{ id: 'child-out', from: 'callChild', to: ['finished'] }],
          }),
        ]),
        frames: [frame({ id: 1, graphKey: 'root' })],
        position: { kind: 'child_output_mapping', frameId: 1, executionId: 5, childFrameId: 2 },
        execution: parentExecution,
      }),
    ),
    ['node_kind_changed'],
  );
});

test('a node that only historical executions used is not required to survive', () => {
  // Deleting a node a run already finished with is ordinary refactoring. Only the active path is
  // checked, which is what makes resuming compatible with editing.
  assert.deepEqual(
    validateSavedPositions({
      descriptor: descriptor([
        graph({
          key: 'root',
          nodes: [{ id: 'work', kind: 'operation' }],
        }),
      ]),
      frames: [rootFrame],
      position: { kind: 'node_callback', frameId: 1, executionId: 1 },
      execution: workExecution,
    }),
    [],
  );
});
