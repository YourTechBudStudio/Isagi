import { Effect } from 'effect';

import type { SurfaceServiceShape } from '../../../surfaces/index.js';
import type { PaneOperationAdapter } from './types.js';

/**
 * Closing a pane is the one journaled capability whose owner call is already idempotent: deleting a
 * pane that is gone reconciles through the surface owner rather than failing, so recovery at this
 * position simply reaches the same terminal state.
 */
export function makePaneAdapter(surfaces: SurfaceServiceShape): PaneOperationAdapter {
  return {
    closePane: (input) =>
      surfaces.deleteSurfacePane({ surfaceId: input.surfaceId, paneId: input.paneId }).pipe(
        Effect.asVoid,
        Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))),
      ),
  };
}
