import assert from 'node:assert/strict';
import test from 'node:test';

import type { SurfaceLayoutNode } from '@isagi/contracts';

import { insertPaneIntoLayout, prunePaneFromLayout, setNodeWeights } from './layout.js';

test('layout pruning removes a matching leaf', () => {
  const layout = leaf(1);

  assert.equal(prunePaneFromLayout(layout, 1), null);
});

test('layout pruning collapses a split with one remaining child', () => {
  const layout: SurfaceLayoutNode = {
    kind: 'split',
    nodeId: 'split-1',
    axis: 'row',
    sizing: 'manual',
    children: [leaf(1), leaf(2)],
    weights: [0.25, 0.75],
  };

  assert.deepEqual(prunePaneFromLayout(layout, 1), leaf(2));
});

test('layout pruning preserves relative weights and normalizes them', () => {
  const layout: SurfaceLayoutNode = {
    kind: 'split',
    nodeId: 'split-1',
    axis: 'column',
    sizing: 'manual',
    children: [leaf(1), leaf(2), leaf(3)],
    weights: [2, 3, 5],
  };

  assert.deepEqual(prunePaneFromLayout(layout, 1), {
    kind: 'split',
    nodeId: 'split-1',
    axis: 'column',
    sizing: 'manual',
    children: [leaf(2), leaf(3)],
    weights: [0.375, 0.625],
  });
});

test('layout pruning assigns equal weights when remaining weights are unusable', () => {
  const layout: SurfaceLayoutNode = {
    kind: 'split',
    nodeId: 'split-1',
    axis: 'row',
    sizing: 'manual',
    children: [leaf(1), leaf(2), leaf(3)],
    weights: [1, 0, Number.NaN],
  };

  assert.deepEqual(prunePaneFromLayout(layout, 1), {
    kind: 'split',
    nodeId: 'split-1',
    axis: 'row',
    sizing: 'manual',
    children: [leaf(2), leaf(3)],
    weights: [0.5, 0.5],
  });
});

test('layout insertion wraps a root leaf for a right split', () => {
  assert.deepEqual(insertPaneIntoLayout(leaf(1), 1, 2, 'right'), {
    kind: 'split',
    nodeId: 'split-2',
    axis: 'row',
    sizing: 'manual',
    children: [leaf(1), leaf(2)],
    weights: [0.5, 0.5],
  });
});

test('layout insertion wraps a root leaf for an up split', () => {
  assert.deepEqual(insertPaneIntoLayout(leaf(1), 1, 2, 'up'), {
    kind: 'split',
    nodeId: 'split-2',
    axis: 'column',
    sizing: 'manual',
    children: [leaf(2), leaf(1)],
    weights: [0.5, 0.5],
  });
});

test('layout insertion flattens into a matching row split after the source', () => {
  const layout: SurfaceLayoutNode = {
    kind: 'split',
    nodeId: 'split-1',
    axis: 'row',
    sizing: 'manual',
    children: [leaf(1), leaf(2)],
    weights: [0.25, 0.75],
  };

  assert.deepEqual(insertPaneIntoLayout(layout, 1, 3, 'right'), {
    ...layout,
    children: [leaf(1), leaf(3), leaf(2)],
    weights: [0.333333, 0.333333, 0.333334],
  });
});

test('layout insertion flattens into a matching row split before the source', () => {
  const layout: SurfaceLayoutNode = {
    kind: 'split',
    nodeId: 'split-1',
    axis: 'row',
    sizing: 'manual',
    children: [leaf(1), leaf(2)],
    weights: [0.25, 0.75],
  };

  assert.deepEqual(insertPaneIntoLayout(layout, 2, 3, 'left'), {
    ...layout,
    children: [leaf(1), leaf(3), leaf(2)],
    weights: [0.333333, 0.333333, 0.333334],
  });
});

test('layout insertion flattens into a matching column split before the source', () => {
  const layout: SurfaceLayoutNode = {
    kind: 'split',
    nodeId: 'split-1',
    axis: 'column',
    sizing: 'manual',
    children: [leaf(1), leaf(2), leaf(3)],
    weights: [0.2, 0.3, 0.5],
  };

  assert.deepEqual(insertPaneIntoLayout(layout, 2, 4, 'up'), {
    ...layout,
    children: [leaf(1), leaf(4), leaf(2), leaf(3)],
    weights: [0.25, 0.25, 0.25, 0.25],
  });
});

test('layout insertion wraps a source leaf when parent axis differs', () => {
  const layout: SurfaceLayoutNode = {
    kind: 'split',
    nodeId: 'split-1',
    axis: 'row',
    sizing: 'manual',
    children: [leaf(1), leaf(2)],
    weights: [0.25, 0.75],
  };

  assert.deepEqual(insertPaneIntoLayout(layout, 1, 3, 'down'), {
    ...layout,
    children: [
      {
        kind: 'split',
        nodeId: 'split-3',
        axis: 'column',
        sizing: 'manual',
        children: [leaf(1), leaf(3)],
        weights: [0.5, 0.5],
      },
      leaf(2),
    ],
  });
});

test('layout weight setting fails when the node is missing', () => {
  const layout: SurfaceLayoutNode = {
    kind: 'split',
    nodeId: 'split-1',
    axis: 'row',
    sizing: 'manual',
    children: [leaf(1), leaf(2)],
    weights: [0.5, 0.5],
  };

  assert.equal(setNodeWeights(layout, 'split-missing', [0.2, 0.8]), null);
});

test('layout weight setting fails when the target node is not a split', () => {
  assert.equal(setNodeWeights(leaf(1), 'pane-1', [1]), null);
});

test('layout weight setting fails when the node child shape changed', () => {
  const layout: SurfaceLayoutNode = {
    kind: 'split',
    nodeId: 'split-1',
    axis: 'row',
    sizing: 'manual',
    children: [leaf(1), leaf(2)],
    weights: [0.5, 0.5],
  };

  assert.equal(setNodeWeights(layout, 'split-1', [0.2, 0.3, 0.5]), null);
});

test('layout weight setting normalizes weights and marks the split manual', () => {
  const layout: SurfaceLayoutNode = {
    kind: 'split',
    nodeId: 'split-1',
    axis: 'row',
    sizing: 'auto',
    children: [leaf(1), leaf(2), leaf(3)],
    weights: [0.5, 0.25, 0.25],
  };

  assert.deepEqual(setNodeWeights(layout, 'split-1', [2, 0, Number.NaN]), {
    ...layout,
    sizing: 'manual',
    weights: [1, 0, 0],
  });
});

function leaf(paneId: number): SurfaceLayoutNode {
  return {
    kind: 'leaf',
    nodeId: `pane-${paneId}`,
    paneId,
    collapsed: false,
  };
}
