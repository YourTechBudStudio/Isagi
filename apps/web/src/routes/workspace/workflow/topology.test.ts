import assert from 'node:assert/strict';
import test from 'node:test';

import { descriptorFixture, graphFixture } from './test-support.js';
import { addressKey, ancestorKeys, buildTopology, parseAddressKey } from './topology.js';

/**
 * Addressing, and the one thing it exists to stop: a reused graph merging two registrations.
 */

const reviewGraph = graphFixture({
  key: 'review',
  entry: 'draft',
  nodes: [
    { id: 'draft', kind: 'operation' },
    { id: 'check', kind: 'operation' },
  ],
  edges: [
    { id: 'after-draft', from: 'draft', to: ['check'] },
    { id: 'after-check', from: 'check', to: ['accepted', 'draft'] },
  ],
  outcomes: [{ id: 'accepted', kind: 'success' }],
});

const rootGraph = graphFixture({
  key: 'root',
  entry: 'first-pass',
  nodes: [
    { id: 'first-pass', kind: 'subgraph', graphKey: 'review' },
    { id: 'second-pass', kind: 'subgraph', graphKey: 'review' },
  ],
  edges: [
    { id: 'after-first', from: 'first-pass', to: ['second-pass'] },
    { id: 'after-second', from: 'second-pass', to: ['shipped'] },
  ],
  outcomes: [{ id: 'shipped', kind: 'success' }],
});

test('one graph registered twice becomes two addresses, not one', () => {
  const topology = buildTopology(descriptorFixture([rootGraph, reviewGraph], 'root'));

  const first = addressKey({ path: ['first-pass'], kind: 'node', id: 'draft' });
  const second = addressKey({ path: ['second-pass'], kind: 'node', id: 'draft' });

  assert.notEqual(first, second);
  assert.ok(topology.elements.has(first));
  assert.ok(topology.elements.has(second));
  // Same definition, two registrations: the graph key is shared and the identity is not.
  assert.equal(topology.elements.get(first)?.graphKey, 'review');
  assert.equal(topology.elements.get(second)?.graphKey, 'review');
});

test('an address round-trips through its key', () => {
  const address = { path: ['outer', 'inner'], kind: 'edge' as const, id: 'after-check' };
  assert.deepEqual(parseAddressKey(addressKey(address)), address);
  assert.deepEqual(parseAddressKey(addressKey({ path: [], kind: 'node', id: 'a' })), {
    path: [],
    kind: 'node',
    id: 'a',
  });
});

test('edges become their own elements, with links on both sides', () => {
  const topology = buildTopology(descriptorFixture([reviewGraph], 'review'));
  const edgeKey = addressKey({ path: [], kind: 'edge', id: 'after-check' });
  assert.equal(topology.elements.get(edgeKey)?.kind, 'edge');

  const intoEdge = topology.links.filter((link) => link.toKey === edgeKey);
  assert.equal(intoEdge.length, 1, 'exactly one arrow reaches the edge function');
  assert.equal(intoEdge[0]?.destinationId, null);

  const outOfEdge = topology.links.filter((link) => link.fromKey === edgeKey);
  assert.deepEqual(
    outOfEdge.map((link) => link.destinationId).sort(),
    ['accepted', 'draft'],
    'every declared destination gets an arrow, outcomes included',
  );
});

test('containment expands to every depth', () => {
  const leaf = graphFixture({
    key: 'leaf',
    entry: 'work',
    nodes: [{ id: 'work', kind: 'operation' }],
    edges: [{ id: 'done', from: 'work', to: ['ok'] }],
    outcomes: [{ id: 'ok', kind: 'success' }],
  });
  const middle = graphFixture({
    key: 'middle',
    entry: 'inner',
    nodes: [{ id: 'inner', kind: 'subgraph', graphKey: 'leaf' }],
    edges: [{ id: 'done', from: 'inner', to: ['ok'] }],
    outcomes: [{ id: 'ok', kind: 'success' }],
  });
  const outer = graphFixture({
    key: 'outer',
    entry: 'mid',
    nodes: [{ id: 'mid', kind: 'subgraph', graphKey: 'middle' }],
    edges: [{ id: 'done', from: 'mid', to: ['ok'] }],
    outcomes: [{ id: 'ok', kind: 'success' }],
  });
  const top = graphFixture({
    key: 'top',
    entry: 'out',
    nodes: [{ id: 'out', kind: 'subgraph', graphKey: 'outer' }],
    edges: [{ id: 'done', from: 'out', to: ['ok'] }],
    outcomes: [{ id: 'ok', kind: 'success' }],
  });

  const topology = buildTopology(descriptorFixture([top, outer, middle, leaf], 'top'));
  const deepest = addressKey({ path: ['out', 'mid', 'inner'], kind: 'node', id: 'work' });
  assert.ok(topology.elements.has(deepest), 'four levels of containment all expand');
  assert.equal(topology.elements.get(deepest)?.depth, 3);
  assert.deepEqual(ancestorKeys(topology, deepest), [
    addressKey({ path: [], kind: 'node', id: 'out' }),
    addressKey({ path: ['out'], kind: 'node', id: 'mid' }),
    addressKey({ path: ['out', 'mid'], kind: 'node', id: 'inner' }),
  ]);
});

test('a subgraph whose graph the descriptor omits is reported, not silently empty', () => {
  const graph = graphFixture({
    key: 'root',
    entry: 'child',
    nodes: [{ id: 'child', kind: 'subgraph', graphKey: 'gone' }],
    edges: [{ id: 'done', from: 'child', to: ['ok'] }],
    outcomes: [{ id: 'ok', kind: 'success' }],
  });
  const topology = buildTopology(descriptorFixture([graph], 'root'));
  assert.deepEqual(topology.unresolvedGraphs, [
    { nodeKey: addressKey({ path: [], kind: 'node', id: 'child' }), graphKey: 'gone' },
  ]);
});

test('a checkpoint node is drawn as a node of its own kind', () => {
  const graph = graphFixture({
    key: 'root',
    entry: 'hold',
    nodes: [{ id: 'hold', kind: 'checkpoint', title: 'Save the phase' }],
    edges: [{ id: 'done', from: 'hold', to: ['ok'] }],
    outcomes: [{ id: 'ok', kind: 'success' }],
  });
  const topology = buildTopology(descriptorFixture([graph], 'root'));
  const element = topology.elements.get(addressKey({ path: [], kind: 'node', id: 'hold' }));
  assert.equal(element?.kind, 'node');
  assert.equal(element?.kind === 'node' ? element.descriptor.kind : null, 'checkpoint');
});
