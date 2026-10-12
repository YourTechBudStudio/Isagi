import { Cause, Effect, Exit, Option } from 'effect';
import { AtomRegistry } from 'effect/reactivity';

import { classifyRuntimeFailure } from '../runtime/classify.js';
import type { RuntimeApi } from '../runtime/client.js';
import { refreshAndRead } from '../state/policy.js';
import { showToast } from '../toast/index.js';
import { cachedWorkspaceData, workspaceReadAtom } from './queries.js';
import {
  anyRailOrderPending,
  railOrderAtom,
  withoutEntry,
  type RailOrderEntry,
} from './rail-order-state.js';
import { applyRailMove, railMoveSiteExists, scopeKey, type RailMoveIntent } from './rail-order.js';
import {
  formatRuntimeErrorSummary,
  moveProjectOrder,
  moveSurfaceOrder,
  moveWorktreeOrder,
} from './runtime-data.js';

/**
 * Commit one rail reorder: show it at once, persist it, and recover locally if the runtime refuses.
 *
 * The interesting problem is not the write, it is that three independent sibling scopes share
 * **one** workspace read, and that read is refreshed by many things (runtime events,
 * reconciliation, focus) that know nothing about reorders. A refresh that read the runtime before a
 * move committed answers with the old order; installing it unchanged would yank the dragged row
 * back under the user's cursor.
 *
 * So the read never holds the projection. `workspaceAtom` is the latest read with the rail's moves
 * replayed on top (`projectRailOrder`): a pending move over every read, an accepted one over every
 * read that began before the acceptance. Whenever a read started or landed, it cannot display an
 * order that lacks a pending or accepted move, and no in-flight read has to be cancelled.
 *
 * 1. Gate, no-op check and claim happen in one synchronous step, so two drops in a scope can never
 *    both claim it. The claim *is* the optimistic projection.
 * 2. The write is uninterruptible: once it reaches the runtime it is never aborted client-side.
 * 3. Accepted → the move moves from pending to accepted. Refused → the pending entry is dropped,
 *    which re-derives only this list from the latest read, and the refusal is reported.
 * 4. Once no scope is pending, one convergence read reconciles with the runtime (which emits no
 *    event for a reorder) and retires the accepted moves that read already contains.
 */

/**
 * What the commit did. The rail drives its feedback from `railOrderAtom` rather than this value; it
 * exists so the outcome is assertable and so a caller can tell "nothing to do" apart from "refused".
 */
export type RailMoveOutcome = 'committed' | 'failed' | 'skipped' | 'blocked';

/** The durable write for one intent (injectable, so the workflow is testable without a network). */
export type PersistRailMove = (intent: RailMoveIntent) => Effect.Effect<unknown, Error, RuntimeApi>;

export const commitRailMove = Effect.fn('commitRailMove')(function* (
  intent: RailMoveIntent,
  persist: PersistRailMove = persistRailMove,
) {
  const key = scopeKey(intent.scope);
  const registry = yield* AtomRegistry.AtomRegistry;

  const decision = yield* Effect.sync(() => claim(registry, key, intent));
  if (decision !== 'claimed') return decision;

  const exit = yield* Effect.exit(Effect.uninterruptible(persist(intent)));
  if (Exit.isSuccess(exit)) {
    registry.update(railOrderAtom, (rail) => {
      // A read that began before this acceptance has `startedAt < acceptedAt` and gets the move
      // replayed; one that begins after has `startedAt === acceptedAt` and already carries it.
      const clock = rail.clock + 1;
      return {
        ...withoutEntry(rail, key),
        clock,
        accepted: [...rail.accepted, { intent, acceptedAt: clock }],
      };
    });
  } else {
    const error = Cause.squash(exit.cause);
    yield* Effect.sync(() => rollBackAndReport(registry, intent, key, error));
    // The runtime's own message is diagnostic and never rendered; it belongs here.
    yield* Effect.logError('[workspace] rail reorder failed', { scope: key, intent, error });
  }

  yield* refreshWhenAllSettled;
  const outcome: RailMoveOutcome = Exit.isSuccess(exit) ? 'committed' : 'failed';
  return outcome;
});

/**
 * The gate, the no-op check and the claim, in one synchronous block that no other fiber can
 * interleave.
 *
 * A list already awaiting a persisted move refuses another; the drag engine also declines the
 * gesture, but the lock lives here so the invariant holds however the intent arrived. A drop that
 * lands an item where it already sits changes nothing a person can see, so it makes no durable
 * request (ADR 0002 — cost should match the action); the runtime would accept it and use the write
 * to compact ranks migrated as ties, but that repair happens on the first genuine move in the list
 * anyway. A new claim also replaces an earlier refusal in this scope: the user has moved on.
 */
function claim(
  registry: AtomRegistry.AtomRegistry,
  key: string,
  intent: RailMoveIntent,
): 'claimed' | 'blocked' | 'skipped' {
  const rail = registry.get(railOrderAtom);
  if (rail.entries[key]?.status === 'pending') return 'blocked';
  const shown = cachedWorkspaceData(registry);
  if (shown === undefined || applyRailMove(shown, intent) === shown) return 'skipped';
  registry.set(railOrderAtom, {
    ...rail,
    entries: { ...rail.entries, [key]: { status: 'pending', movedId: intent.movedId, intent } },
  });
  return 'claimed';
}

/**
 * Roll back only this list and put the refusal where the user is looking.
 *
 * Dropping the pending entry re-derives this list from the latest read; every other scope's
 * pending and accepted moves are untouched. Normally the refusal then goes inline at the list
 * (ADR 0004). The exception is when the thing they dragged is no longer on screen to hold a message
 * — either because the runtime said so, or because the rolled-back workspace no longer contains
 * it. Then, and only then, it becomes a toast, and the scope is left clear: a failed entry would
 * keep the message alive at a list that is no longer there to show it.
 */
function rollBackAndReport(
  registry: AtomRegistry.AtomRegistry,
  intent: RailMoveIntent,
  key: string,
  error: unknown,
): void {
  registry.update(railOrderAtom, (rail) => withoutEntry(rail, key));
  const message = formatRuntimeErrorSummary(error);
  const shown = cachedWorkspaceData(registry);
  const siteGone =
    rejectionRemovedSite(intent, error) || !(shown && railMoveSiteExists(shown, intent));

  if (siteGone) {
    showToast(registry, { id: `rail-order-failed:${key}`, kind: 'warning', title: message });
  } else {
    const failed: RailOrderEntry = { status: 'failed', movedId: intent.movedId, message };
    registry.update(railOrderAtom, (rail) => ({
      ...rail,
      entries: { ...rail.entries, [key]: failed },
    }));
  }
}

/**
 * Whether the rejection itself proves the dragged row or its list is gone.
 *
 * Only source and parent reasons qualify. A `before_*` reason means the *anchor* vanished, which
 * leaves the initiating row perfectly able to host the message, and a mismatch or pinned-root
 * reason means the target exists and the client asked for something illegal. Transport and decode
 * failures carry no domain fact at all, so they fall through to the workspace check.
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
 * While another scope is still pending, nothing happens: that scope's own settlement converges
 * everything, and a stale read landing meanwhile has this move replayed onto it (it is accepted
 * now), so nothing needs cancelling. Otherwise one read, begun now, replaces whatever is in flight;
 * the accepted moves it began after are in the runtime's own order and stop being replayed.
 *
 * A failure *here* is ordinary read staleness, not a failed drag: the runtime already accepted (or
 * refused) the move and the user has been told, so it is logged and swallowed. The workspace read
 * reports its own failure through ordinary query state, still showing the projected last success.
 */
const refreshWhenAllSettled = Effect.gen(function* () {
  const registry = yield* AtomRegistry.AtomRegistry;
  if (anyRailOrderPending(registry.get(railOrderAtom))) return;
  const read = yield* refreshAndRead(workspaceReadAtom).pipe(
    Effect.map(Option.some),
    Effect.catch((error) =>
      Effect.as(Effect.logError('[workspace] rail reorder refresh failed', error), Option.none()),
    ),
  );
  if (Option.isNone(read)) return;
  const startedAt = read.value.startedAt;
  registry.update(railOrderAtom, (rail) => ({
    ...rail,
    accepted: rail.accepted.filter((accepted) => accepted.acceptedAt > startedAt),
  }));
});

function persistRailMove(intent: RailMoveIntent): Effect.Effect<unknown, Error, RuntimeApi> {
  const { scope, beforeId } = intent;
  switch (scope.kind) {
    case 'projects':
      return moveProjectOrder(intent.movedId, { beforeProjectId: beforeId });
    case 'worktrees':
      return moveWorktreeOrder(scope.projectId, intent.movedId, { beforeWorktreeId: beforeId });
    case 'surfaces':
      return moveSurfaceOrder(scope.worktreeId, intent.movedId, { beforeSurfaceId: beforeId });
  }
}
