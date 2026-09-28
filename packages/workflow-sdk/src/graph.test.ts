import assert from 'node:assert/strict';
import test from 'node:test';

import { isWorkflowBranded } from './brand.js';
import { createGraph, defineWorkflow, edge, outcome } from './graph.js';
import { workflowIdentifierPattern } from './identifiers.js';
import { checkpoint, operation, subgraph } from './nodes.js';
import { complete, wait } from './operations.js';
import { reduce } from './state.js';

type State = { readonly note: string };

const noteGraph = createGraph<State, {}, { readonly note: string }, string>({
  key: 'Note',
  title: 'Note',
  init: (_destination, parameters) => ({ note: parameters.note }),
  state: { note: reduce.replace<string>() },
  entry: 'ack',
  nodes: { ack: operation(async () => complete({ update: { note: 'acked' } })) },
  edges: { fromAck: edge({ from: 'ack', to: ['done'], choose: () => ({ to: 'done' }) }) },
  outcomes: { done: outcome({ kind: 'success', output: (state) => state.note }) },
});

test('every registration constructor brands its result', () => {
  assert.ok(isWorkflowBranded(noteGraph, 'graph'));
  assert.ok(isWorkflowBranded(noteGraph.nodes.ack, 'operation-node'));
  assert.ok(isWorkflowBranded(noteGraph.edges.fromAck, 'edge'));
  assert.ok(isWorkflowBranded(noteGraph.outcomes.done, 'outcome'));
  assert.ok(isWorkflowBranded(checkpoint({ prepare: () => ({ capture: [] }) }), 'checkpoint-node'));
  assert.ok(
    isWorkflowBranded(
      subgraph({
        graph: noteGraph,
        parameters: (parent: State) => ({ note: parent.note }),
        onResult: () => ({}),
      }),
      'subgraph-node',
    ),
  );
});

test('a graph object is reusable: two registrations reference one definition', () => {
  const first = subgraph({
    graph: noteGraph,
    parameters: (parent: State) => ({ note: parent.note }),
    onResult: () => ({}),
  });
  const second = subgraph({
    graph: noteGraph,
    parameters: (parent: State) => ({ note: `${parent.note}!` }),
    onResult: () => ({}),
  });
  assert.equal(first.graph, second.graph);
  assert.notEqual(first, second);
});

test('constructors preserve the author-declared destination order and optional metadata', () => {
  const router = edge({
    from: 'ack',
    to: ['revise', 'done'],
    choose: () => ({ to: 'done' }),
    title: 'Route the acknowledgement',
  });
  assert.deepEqual([...router.to], ['revise', 'done']);
  assert.equal(router.title, 'Route the acknowledgement');
  assert.equal(
    edge({ from: 'ack', to: ['done'], choose: () => ({ to: 'done' }) }).title,
    undefined,
  );
});

test('a checkpoint carries a pure prepare and static metadata, not a display-name callback', () => {
  const prepare = (state: State) => ({
    title: state.note,
    capture: [{ scope: 'notes', directory: 'notes', exclude: undefined }],
  });
  const node = checkpoint({ prepare, title: 'Save notes', description: 'After review.' });
  assert.equal(node.prepare, prepare);
  assert.equal(node.title, 'Save notes');
  assert.equal(node.description, 'After review.');
  assert.equal('label' in node, false);
  assert.equal('caption' in node, false);
});

test('defineWorkflow brands the definition and keeps the launch surface callable', async () => {
  const workflow = defineWorkflow<{ readonly note: string }, string>({
    command: () => ({ title: 'Note', inputs: [{ kind: 'text', key: 'note', label: 'Note' }] }),
    validate: (_origin, inputs) => {
      if (!inputs.note) throw new Error('note is required.');
    },
    graph: noteGraph,
  });
  assert.ok(isWorkflowBranded(workflow, 'workflow'));
  assert.equal(
    (await workflow.command({ worktreeId: 1, worktreePath: '/w', surfaceId: 1 })).title,
    'Note',
  );
  assert.equal(workflow.graph, noteGraph);
});

test('a node callback and its router run without a context for pure decisions', async () => {
  const ack = noteGraph.nodes.ack;
  assert.ok(isWorkflowBranded(ack, 'operation-node'));
  const result = await ack.run(undefined as never, { note: 'hello' });
  assert.equal(result.type, 'complete');
  assert.deepEqual(noteGraph.edges.fromAck!.choose({ note: 'acked' }, { kind: 'immediate' }), {
    to: 'done',
  });
});

test('the identifier pattern accepts author ids and rejects the shapes validation must catch', () => {
  for (const accepted of ['a', 'askWriter', 'review-2', 'A_b', `a${'b'.repeat(63)}`]) {
    assert.ok(workflowIdentifierPattern.test(accepted), accepted);
  }
  for (const rejected of [
    '',
    '1node',
    '-node',
    'node.id',
    'node id',
    'nodeü',
    `a${'b'.repeat(64)}`,
  ]) {
    assert.equal(workflowIdentifierPattern.test(rejected), false, rejected);
  }
});

test('a wait declaration is plain data an author can build ahead of suspending', () => {
  assert.deepEqual(wait.userInput([]), { kind: 'user_input', questions: [] });
});
