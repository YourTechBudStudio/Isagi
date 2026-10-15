import { Data } from 'effect';

import type { SurfaceOrderRejectionReason } from '@isagi/contracts';

// The surfaces domain's expected-failure channel.
//
// These live in their own module rather than beside the service because the
// service is not their only constructor: `open-editor.ts` raises
// `SurfaceError` from its pre-lock worktree guard and the repository aborts
// creating transactions with it. Importing them from `service.ts` — which
// imports both — would close a module cycle between eagerly-evaluated modules.

export class SurfaceError extends Data.TaggedError('SurfaceError')<{
  readonly code:
    | 'surface_not_found'
    | 'worktree_not_found'
    | 'pane_not_found'
    | 'session_not_found'
    | 'session_worktree_mismatch'
    | 'process_incarnation_stale'
    | 'session_already_attached'
    | 'invalid_surface_title'
    | 'layout_node_stale'
    | 'surface_not_empty';
  readonly message: string;
  readonly worktreeId?: number | undefined;
  readonly surfaceId?: number | undefined;
  readonly paneId?: number | undefined;
  readonly sessionId?: number | undefined;
}> {}

/**
 * Kept separate from `SurfaceError` because reordering has its own contract
 * error (`surface_order_rejected`) and reason set; its reason maps straight
 * through to that contract.
 */
export class SurfaceOrderError extends Data.TaggedError('SurfaceOrderError')<{
  readonly reason: SurfaceOrderRejectionReason;
  readonly message: string;
  readonly worktreeId: number;
  readonly surfaceId: number;
  readonly beforeSurfaceId?: number | undefined;
}> {}
