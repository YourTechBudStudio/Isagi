import assert from 'node:assert/strict';
import test from 'node:test';

import { buildLayoutRequest, drawnOrder, layoutIdentity, nodeSize } from './layout.js';
import { descriptorFixture, graphFixture } from './test-support.js';
import { addressKey, buildTopology } from './topology.js';

/**
 * The relayout rule, tested at the only place it can be decided: the identity of a request.
 *
 * Nothing about timing, status, selection or operation settlement may appear in it. If any of them
 * did, a live run would lay itself out again several times a minute and the graph would twitch under
 * whoever was reading it.
 */

const topology = buildTopology(
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

const writerKey = addressKey({ path: [], kind: 'node', id: 'writer' });
const reviewerKey = addressKey({ path: [], kind: 'node', id: 'reviewer' });

const identity = (input: { pin?: string; expanded?: readonly string[] }) =>
  layoutIdentity({
    artifactHash: input.pin ?? 'sha256:pin-a',
    expanded: new Set(input.expanded ?? []),
  });

test('the identity is the pin and the open set, and nothing else', () => {
  const base = identity({});
  assert.equal(identity({}), base, 'the same shape is the same request');
  // The pin's own hash, so a Retry that changed an edge or a node kind without renaming anything
  // still re-lays out. A summary of the element keys would have been identical.
  assert.notEqual(identity({ pin: 'sha256:pin-b' }), base);
  assert.notEqual(identity({ expanded: [reviewerKey] }), base, 'opening a box re-lays out');
});

test('the identity does not depend on the order a set was built in', () => {
  assert.equal(
    identity({ expanded: [reviewerKey, writerKey] }),
    identity({ expanded: [writerKey, reviewerKey] }),
  );
});

test('an expanded subgraph sends its children; a collapsed one sends a reserved box', () => {
  const collapsed = buildLayoutRequest({
    topology,
    identity: 'x',
    expanded: new Set(),
  });
  const reviewer = collapsed.nodes.find((node) => node.id === reviewerKey);
  assert.equal(reviewer?.children, undefined);
  assert.equal(reviewer?.width, nodeSize.collapsedSubgraph.width);

  const expanded = buildLayoutRequest({
    topology,
    identity: 'x',
    expanded: new Set([reviewerKey]),
  });
  const openBox = expanded.nodes.find((node) => node.id === reviewerKey);
  assert.ok(openBox?.children && openBox.children.length > 0);
  assert.ok(openBox.padding, 'an open box reserves a header strip for its own name');
});

test('only serializable topology crosses the worker boundary', () => {
  const request = buildLayoutRequest({
    topology,
    identity: 'x',
    expanded: new Set([reviewerKey]),
  });
  // Nothing that could carry a status, a timestamp or a callback: a structured clone of the request
  // is the request.
  assert.deepEqual(JSON.parse(JSON.stringify(request)), request);
  assert.deepEqual(Object.keys(request).sort(), ['edges', 'identity', 'nodes']);
});

test('an operation node reserves its visit strip from the first layout', () => {
  const request = buildLayoutRequest({ topology, identity: 'x', expanded: new Set() });
  const writer = request.nodes.find((node) => node.id === writerKey);
  // One size, whatever the run records: a node that grew on its second visit would have to be laid
  // out again, and "a new visit moves nothing" would stop being true.
  assert.equal(writer?.height, nodeSize.operation.height);
  assert.equal(
    Object.values(nodeSize).filter((size) => size.height === nodeSize.operation.height).length,
    1,
    'there is no second operation size to drift back to',
  );
});

test('the drawn order is one order, and a collapsed box contributes itself alone', () => {
  const collapsed = drawnOrder(topology, new Set());
  assert.deepEqual(collapsed, [
    writerKey,
    reviewerKey,
    addressKey({ path: [], kind: 'outcome', id: 'shipped' }),
    addressKey({ path: [], kind: 'edge', id: 'after-writer' }),
    addressKey({ path: [], kind: 'edge', id: 'after-reviewer' }),
  ]);

  const opened = drawnOrder(topology, new Set([reviewerKey]));
  assert.ok(
    opened.includes(addressKey({ path: ['reviewer'], kind: 'node', id: 'read' })),
    'an open box contributes its contents, right after itself',
  );
  assert.equal(
    opened.indexOf(addressKey({ path: ['reviewer'], kind: 'node', id: 'read' })),
    opened.indexOf(reviewerKey) + 1,
  );
});
