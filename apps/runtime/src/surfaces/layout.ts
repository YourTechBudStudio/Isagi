import type { SplitPaneDirection, SurfaceLayoutNode } from '@isagi/contracts';

type InsertSide = 'before' | 'after';

export function prunePaneFromLayout(
  layout: SurfaceLayoutNode,
  paneId: number,
): SurfaceLayoutNode | null {
  if (layout.kind === 'leaf') {
    return layout.paneId === paneId ? null : layout;
  }

  const children: SurfaceLayoutNode[] = [];
  const weights: number[] = [];
  layout.children.forEach((child, index) => {
    const pruned = prunePaneFromLayout(child, paneId);
    if (!pruned) {
      return;
    }
    children.push(pruned);
    weights.push(layout.weights[index] ?? 0);
  });

  if (children.length === 0) {
    return null;
  }
  if (children.length === 1) {
    return children[0] ?? null;
  }

  return {
    ...layout,
    children,
    weights: normalizeWeights(weights),
  };
}

export function insertPaneIntoLayout(
  layout: SurfaceLayoutNode,
  sourcePaneId: number,
  newPaneId: number,
  direction: SplitPaneDirection,
): SurfaceLayoutNode {
  const axis = axisForDirection(direction);
  const side = sideForDirection(direction);
  const inserted = insertIntoNode(layout, sourcePaneId, newPaneId, axis, side);
  return inserted ?? layout;
}

export function layoutContainsPane(layout: SurfaceLayoutNode, paneId: number): boolean {
  if (layout.kind === 'leaf') return layout.paneId === paneId;
  return layout.children.some((child) => layoutContainsPane(child, paneId));
}

export function setNodeWeights(
  layout: SurfaceLayoutNode,
  nodeId: string,
  weights: readonly number[],
): SurfaceLayoutNode | null {
  const result = setNodeWeightsInNode(layout, nodeId, weights);
  return result.found ? result.layout : null;
}

function setNodeWeightsInNode(
  layout: SurfaceLayoutNode,
  nodeId: string,
  weights: readonly number[],
): { readonly found: true; readonly layout: SurfaceLayoutNode } | { readonly found: false } {
  if (layout.nodeId === nodeId) {
    if (layout.kind !== 'split' || weights.length !== layout.children.length) {
      return { found: false };
    }
    return {
      found: true,
      layout: {
        ...layout,
        sizing: 'manual',
        weights: normalizeWeights(weights),
      },
    };
  }

  if (layout.kind === 'leaf') {
    return { found: false };
  }

  const children: SurfaceLayoutNode[] = [];
  for (const child of layout.children) {
    const result = setNodeWeightsInNode(child, nodeId, weights);
    if (!result.found) {
      children.push(child);
      continue;
    }
    children.push(result.layout);
    return {
      found: true,
      layout: {
        ...layout,
        children: [...children, ...layout.children.slice(children.length)],
      },
    };
  }

  return { found: false };
}

function insertIntoNode(
  node: SurfaceLayoutNode,
  sourcePaneId: number,
  newPaneId: number,
  axis: 'row' | 'column',
  side: InsertSide,
): SurfaceLayoutNode | null {
  if (node.kind === 'leaf') {
    if (node.paneId !== sourcePaneId) return null;
    const newLeaf = leafForPane(newPaneId);
    return {
      kind: 'split',
      nodeId: `split-${newPaneId}`,
      axis,
      sizing: 'manual',
      children: side === 'after' ? [node, newLeaf] : [newLeaf, node],
      weights: [0.5, 0.5],
    };
  }

  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index];
    if (!child) continue;

    if (child.kind === 'leaf' && child.paneId === sourcePaneId && node.axis === axis) {
      return insertLeafIntoSameAxisSplit(node, index, newPaneId, side);
    }

    const inserted = insertIntoNode(child, sourcePaneId, newPaneId, axis, side);
    if (!inserted) continue;

    return {
      ...node,
      children: node.children.map((candidate, childIndex) =>
        childIndex === index ? inserted : candidate,
      ),
    };
  }

  return null;
}

function insertLeafIntoSameAxisSplit(
  node: Extract<SurfaceLayoutNode, { readonly kind: 'split' }>,
  sourceIndex: number,
  newPaneId: number,
  side: InsertSide,
): SurfaceLayoutNode {
  const sourceWeight = node.weights[sourceIndex] ?? 0;
  const splitWeight = sourceWeight / 2;
  const children = [...node.children];
  const weights = [...node.weights];
  weights[sourceIndex] = splitWeight;
  const insertIndex = side === 'after' ? sourceIndex + 1 : sourceIndex;
  children.splice(insertIndex, 0, leafForPane(newPaneId));
  weights.splice(insertIndex, 0, splitWeight);

  return {
    ...node,
    children,
    weights: normalizeWeights(weights),
  };
}

function leafForPane(paneId: number): SurfaceLayoutNode {
  return {
    kind: 'leaf',
    nodeId: `pane-${paneId}`,
    paneId,
    collapsed: false,
  };
}

function axisForDirection(direction: SplitPaneDirection) {
  return direction === 'left' || direction === 'right' ? 'row' : 'column';
}

function sideForDirection(direction: SplitPaneDirection): InsertSide {
  return direction === 'right' || direction === 'down' ? 'after' : 'before';
}

function normalizeWeights(weights: readonly number[]) {
  const clean = weights.map((weight) => (Number.isFinite(weight) && weight > 0 ? weight : 0));
  const total = clean.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) {
    return equalWeights(clean.length);
  }

  const normalized = clean.map((weight) => roundWeight(weight / total));
  const delta = roundWeight(1 - normalized.reduce((sum, weight) => sum + weight, 0));
  const largestIndex = normalized.reduce(
    (largest, weight, index) => (weight > normalized[largest]! ? index : largest),
    0,
  );
  normalized[largestIndex] = roundWeight(normalized[largestIndex]! + delta);
  return normalized;
}

function equalWeights(count: number) {
  const weights = Array.from({ length: count }, () => roundWeight(1 / count));
  const delta = roundWeight(1 - weights.reduce((sum, weight) => sum + weight, 0));
  weights[weights.length - 1] = roundWeight(weights[weights.length - 1]! + delta);
  return weights;
}

function roundWeight(weight: number) {
  return Math.round(weight * 1_000_000) / 1_000_000;
}
