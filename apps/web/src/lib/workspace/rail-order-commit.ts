import type { QueryClient } from '@tanstack/react-query';

import { queryClient } from '../query/client.js';
import { classifyRuntimeFailure } from '../runtime/classify.js';
import { runRuntimeEffect } from '../runtime/run.js';
import { showToast } from '../toast/index.js';
import type { WorkspaceData } from './model.js';
import { workspaceQueryKey } from './query-keys.js';
import { anyRailOrderPending, isRailOrderPending, useRailOrderStore } from './rail-order-state.js';
import {
  applyRailMove,
  railMoveSiteExists,
  railSiblingIds,
  restoreRailOrder,
  scopeKey,
  type RailMoveIntent,
} from './rail-order.js';
import {
  formatRuntimeErrorSummary,
  moveProjectOrder,
  moveSurfaceOrder,
  moveWorktreeOrder,
} from './runtime-data.js';

/**
 * Commit one rail reorder: project it into the workspace cache, persist it, and
 * recover locally if the runtime refuses.
 *
 * The interesting problem here is not the mutation, it is that three independent
 * sibling scopes share **one** cached snapshot. A per-scope lock stops a second
 * drop in the same list, but it does nothing about a surface reorder and a
 * project reorder overlapping: both write the same cache entry, and either one's
 * refresh would fetch away the other's optimistic order. So the discipline is:
 *
 * 1. Cancel any in-flight workspace fetch before projecting, so a refresh
 *    already on the wire cannot land on top of this move.
 * 2. Re-read the cache *after* cancelling and re-decide, because the drop
 *    decision was made against whatever was on screen a moment ago.
 * 3. Refresh only when no reorder remains pending in **any** scope, so the last
 *    operation to settle is the one that reconciles with the runtime.
 *
 * Cancelling only covers fetches already running, and this workflow is not the
 * only thing that refreshes the workspace. A fetch started *after* the cancel —
 * by a runtime event, or by reconciliation finishing — would arrive carrying the
 * pre-move order. That is why the pending intent is kept in the scope store and
 * replayed over every snapshot the query decodes (`applyPendingRailMoves`), for
 * as long as the write is outstanding. Replay stops the moment a move settles,
 * so settling also cancels the workspace query even when the refresh itself is
 * deferred to a still-pending scope — otherwise a request that read the runtime
 * before this write committed could land and undo it.
 *
 * The runtime emits no event for a reorder (Phase 03), so that final refresh is
 * the only thing that converges this client with the durable order.
 */

/**
 * What the commit did. Phase 05 drives its feedback from the scope store rather
 * than this value; it exists so the outcome is assertable and so a caller can
 * tell "nothing to do" apart from "refused".
 */
export type RailMoveOutcome = 'committed' | 'failed' | 'skipped' | 'blocked';

export interface RailMoveCommitOptions {
  readonly intent: RailMoveIntent;
  readonly client?: QueryClient | undefined;
  /** Injectable persistence, so the workflow is testable without a fetch mock. */
  readonly move?: ((intent: RailMoveIntent) => Promise<unknown>) | undefined;
}

export async function commitRailMove(options: RailMoveCommitOptions): Promise<RailMoveOutcome> {
  const { intent } = options;
  const client = options.client ?? queryClient;
  const move = options.move ?? persistRailMove;
  const key = scopeKey(intent.scope);

  // A list already awaiting a persisted move refuses another. The drag engine
  // also declines the gesture, but the lock lives here so the invariant holds
  // however the intent arrived.
  if (isRailOrderPending(key)) return 'blocked';
  if (isNoOp(client, intent)) return 'skipped';

  // Claimed synchronously, before the first await, so two drops in this scope
  // cannot both get past the check above.
  useRailOrderStore.getState().beginRailOrder(key, intent);

  try {
    await client.cancelQueries({ queryKey: workspaceQueryKey, exact: true });

    // The drop was aimed at the rail as it looked before that cancel resolved.
    // Re-deciding here is what keeps a move honest when a concurrent refresh or
    // another scope's settlement changed the snapshot in between.
    const current = client.getQueryData<WorkspaceData>(workspaceQueryKey);
    const projected = current ? applyRailMove(current, intent) : undefined;
    if (!current || !projected || projected === current) {
      useRailOrderStore.getState().clearRailOrder(key);
      return 'skipped';
    }

    // Captured after the cancel, from the snapshot actually being modified —
    // capturing before would restore an order that was already superseded.
    const captured = railSiblingIds(current, intent.scope) ?? [];
    client.setQueryData<WorkspaceData>(workspaceQueryKey, projected);

    try {
      await move(intent);
      useRailOrderStore.getState().clearRailOrder(key);
      return 'committed';
    } catch (error) {
      rollback(client, intent, captured);
      reportFailure(client, intent, key, error);
      return 'failed';
    }
  } finally {
    // Every path that reaches here cancelled a workspace fetch, so it owes the
    // query a chance to converge — including the post-cancel no-op. The common
    // no-op returns above, before any cancel, and costs nothing at all.
    await refreshWhenAllSettled(client);
  }
}

/**
 * A drop that lands an item where it already sits changes nothing a person can
 * see, so it makes no durable request (ADR 0002 — cost should match the action).
 * The runtime would accept it and use the write to compact ranks migrated as
 * ties, but that repair happens on the first genuine move in the list anyway.
 */
function isNoOp(client: QueryClient, intent: RailMoveIntent): boolean {
  const data = client.getQueryData<WorkspaceData>(workspaceQueryKey);
  return !data || applyRailMove(data, intent) === data;
}

/** Restore only the failed list, against whatever the cache holds now. */
function rollback(client: QueryClient, intent: RailMoveIntent, captured: readonly number[]) {
  const latest = client.getQueryData<WorkspaceData>(workspaceQueryKey);
  if (!latest) return;
  client.setQueryData<WorkspaceData>(
    workspaceQueryKey,
    restoreRailOrder(latest, intent.scope, captured),
  );
}

/**
 * Put the refusal where the user is looking.
 *
 * Normally that is the list itself, inline (ADR 0004). The exception is when the
 * thing they dragged is no longer on screen to hold a message — either because
 * the runtime told us so, or because the rolled-back cache no longer contains
 * it. Then, and only then, it becomes a toast.
 */
function reportFailure(client: QueryClient, intent: RailMoveIntent, key: string, error: unknown) {
  const message = formatRuntimeErrorSummary(error);
  const latest = client.getQueryData<WorkspaceData>(workspaceQueryKey);
  const siteGone =
    rejectionRemovedSite(intent, error) || !(latest && railMoveSiteExists(latest, intent));

  if (siteGone) {
    // The scope has to be released either way. A failed entry would keep the
    // message alive at a list that is no longer there to show it — and, worse,
    // a pending one would lock that list and stall every scope's refresh.
    useRailOrderStore.getState().clearRailOrder(key);
    showToast({ id: `rail-order-failed:${key}`, kind: 'warning', title: message });
  } else {
    useRailOrderStore.getState().failRailOrder(key, intent.movedId, message);
  }
  // The runtime's own message is diagnostic and never rendered; it belongs here.
  console.error('[workspace] rail reorder failed', { scope: key, intent, error });
}

/**
 * Whether the rejection itself proves the dragged row or its list is gone.
 *
 * Only source and parent reasons qualify. A `before_*` reason means the *anchor*
 * vanished, which leaves the initiating row perfectly able to host the message,
 * and a mismatch or pinned-root reason means the target exists and the client
 * asked for something illegal. Transport and decode failures carry no domain
 * fact at all, so they fall through to the cache check in `reportFailure`.
 */
function rejectionRemovedSite(intent: RailMoveIntent, error: unknown): boolean {
  const classified = classifyRuntimeFailure(error);
  if (classified.kind !== 'api') return false;
  const { code, data } = classified.apiError;
  const reason = data && typeof data === 'object' && 'reason' in data ? data.reason : undefined;
  if (typeof reason !== 'string') return false;

  switch (intent.scope.kind) {
    case 'projects':
      return (
        code === 'project_order_rejected' &&
        (reason === 'project_not_found' || reason === 'project_not_present')
      );
    case 'worktrees':
      return (
        code === 'worktree_order_rejected' &&
        (reason === 'project_not_found' ||
          reason === 'project_not_present' ||
          reason === 'worktree_not_found')
      );
    case 'surfaces':
      return (
        code === 'surface_order_rejected' &&
        (reason === 'worktree_not_found' || reason === 'surface_not_found')
      );
  }
}

/**
 * Reconcile with the runtime once every scope has settled.
 *
 * Invalidation refetches the active rail query and supersedes an older refetch,
 * and a scope that is still mid-write would have its optimistic order fetched
 * away — hence the guard. A failure *here* is ordinary query-layer staleness: an
 * accepted mutation is never rolled back because its follow-up refresh failed.
 *
 * Deferring is not the same as doing nothing. This move has just settled, so its
 * intent is no longer replayed onto arriving snapshots — and a fetch that read
 * the runtime *before* this write committed is still on the wire, carrying the
 * order from before it. Handing the deferral to the last scope without
 * cancelling would let that answer land and erase a move the runtime has already
 * accepted, until the final refresh eventually put it back. So a deferred
 * settlement still cancels: any fetch started after this point is by definition
 * fresh enough to see this move, and the remaining scope's own refresh is what
 * converges the rest.
 */
async function refreshWhenAllSettled(client: QueryClient) {
  if (anyRailOrderPending()) {
    await client.cancelQueries({ queryKey: workspaceQueryKey, exact: true });
    return;
  }
  try {
    await client.invalidateQueries({ queryKey: workspaceQueryKey, exact: true });
  } catch (error) {
    // Swallowed deliberately. The runtime already accepted (or refused) the move
    // and the user has been told; a convergence refresh that could not even be
    // started must not surface at the drop site as though the drag failed. The
    // workspace query reports its own staleness through ordinary query state.
    console.error('[workspace] rail reorder refresh failed', error);
  }
}

function persistRailMove(intent: RailMoveIntent): Promise<unknown> {
  const { scope, beforeId } = intent;
  switch (scope.kind) {
    case 'projects':
      return runRuntimeEffect(moveProjectOrder(intent.movedId, { beforeProjectId: beforeId }));
    case 'worktrees':
      return runRuntimeEffect(
        moveWorktreeOrder(scope.projectId, intent.movedId, { beforeWorktreeId: beforeId }),
      );
    case 'surfaces':
      return runRuntimeEffect(
        moveSurfaceOrder(scope.worktreeId, intent.movedId, { beforeSurfaceId: beforeId }),
      );
  }
}
