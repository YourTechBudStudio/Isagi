import type { SurfaceLayoutNode } from '@isagi/contracts';

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
