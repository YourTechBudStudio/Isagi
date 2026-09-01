import { Data } from 'effect';

import type { SurfaceOrderRejectionReason } from '@isagi/contracts';

// The surfaces domain's expected-failure channel.
//
// These live in their own module rather than beside the service because the
// service is no longer their only constructor: `open-editor.ts` raises
// `SurfaceError` from its pre-lock worktree guard, and `editor/api.ts` names
// both classes while mapping a composed operation's failures. Importing them
// from `surfaces.service.ts` — which imports `open-editor.ts` — would close a
// module cycle between two eagerly-evaluated modules.

export class SurfaceError extends Data.TaggedError('SurfaceError')<{
  readonly code:
    | 'surface_not_found'
    | 'worktree_not_found'
    | 'pane_not_found'
    | 'session_not_found'
    | 'session_worktree_mismatch'
    | 'invalid_surface_title'
    | 'layout_node_stale';
  readonly message: string;
  readonly worktreeId?: number | undefined;
  readonly surfaceId?: number | undefined;
  readonly paneId?: number | undefined;
  readonly sessionId?: number | undefined;
}> {}

/**
 * Kept separate from `SurfaceError` because `surfaceRejectionReason` ends in a
 * catch-all default: a reorder reason added to that union and left unmapped
 * would surface as `surface_not_found`. This one maps straight through.
 */
export class SurfaceOrderError extends Data.TaggedError('SurfaceOrderError')<{
  readonly reason: SurfaceOrderRejectionReason;
  readonly message: string;
  readonly worktreeId: number;
  readonly surfaceId: number;
  readonly beforeSurfaceId?: number | undefined;
}> {}
