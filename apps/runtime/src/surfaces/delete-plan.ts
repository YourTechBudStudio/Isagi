import type { SurfaceLayoutNode } from '@isagi/contracts';

import { decodeSurfaceLayout, prunePaneFromLayout } from './layout.js';
import type { SurfaceDeleteTarget } from './types.js';

/**
 * Removing one pane. It never removes the surface: deleting the last pane leaves an empty surface
 * (`nextLayout` null), and only an explicit surface delete takes the surface away. That keeps a
 * surface a workflow run is attached to alive after the run closes its last agent pane.
 */
export interface SurfacePaneDeletePlan {
  readonly deletedPaneIds: readonly number[];
  readonly nextLayout: SurfaceLayoutNode | null;
}

export function planSurfacePaneDelete(
  target: SurfaceDeleteTarget,
  paneId: number,
): SurfacePaneDeletePlan {
  const layout = decodeSurfaceLayout(target.surface.layoutJson);
  if (!target.panes.some(({ pane }) => pane.id === paneId)) {
    return { deletedPaneIds: [], nextLayout: layout };
  }
  const nextLayout = layout === null ? null : prunePaneFromLayout(layout, paneId);
  const remainingPaneIds = target.panes
    .map(({ pane }) => pane.id)
    .filter((candidate) => candidate !== paneId);
  // A layout that places none of the remaining panes is corrupt: those panes could never be shown
  // or reached again. Removing them with the requested one leaves an honest empty surface.
  if (nextLayout === null && remainingPaneIds.length > 0) {
    return { deletedPaneIds: [paneId, ...remainingPaneIds], nextLayout: null };
  }
  return { deletedPaneIds: [paneId], nextLayout };
}
