import { Schema } from 'effect';

import { surfaceLayoutNodeSchema, type SurfaceLayoutNode } from '@isagi/contracts';

import { prunePaneFromLayout } from './layout.js';
import type { SurfaceDeleteTarget } from './types.js';

export interface SurfacePaneDeletePlan {
  readonly deletedSurfaceId: number | null;
  readonly deletedPaneIds: readonly number[];
  readonly nextLayout: SurfaceLayoutNode | null;
}

export function planSurfacePaneDelete(
  target: SurfaceDeleteTarget,
  paneId: number,
): SurfacePaneDeletePlan {
  const paneTarget = target.panes.find(({ pane }) => pane.id === paneId);
  if (!paneTarget) {
    return {
      deletedSurfaceId: null,
      deletedPaneIds: [],
      nextLayout: decodeLayout(target.surface.layoutJson),
    };
  }

  const remainingPaneCount = target.panes.length - 1;
  if (remainingPaneCount <= 0) {
    return deleteSurfacePlan(target);
  }

  const nextLayout = prunePaneFromLayout(decodeLayout(target.surface.layoutJson), paneId);
  if (!nextLayout) {
    return deleteSurfacePlan(target);
  }

  return {
    deletedSurfaceId: null,
    deletedPaneIds: [paneId],
    nextLayout,
  };
}

function deleteSurfacePlan(target: SurfaceDeleteTarget): SurfacePaneDeletePlan {
  return {
    deletedSurfaceId: target.surface.id,
    deletedPaneIds: target.panes.map(({ pane }) => pane.id),
    nextLayout: null,
  };
}

function decodeLayout(layoutJson: string) {
  return Schema.decodeUnknownSync(surfaceLayoutNodeSchema)(JSON.parse(layoutJson));
}
