import assert from 'node:assert/strict';
import test from 'node:test';

import type { SurfaceLayoutNode } from '@isagi/contracts';

import { prunePaneFromLayout } from './layout.js';

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

function leaf(paneId: number): SurfaceLayoutNode {
  return {
    kind: 'leaf',
    nodeId: `pane-${paneId}`,
    paneId,
    collapsed: false,
  };
}
