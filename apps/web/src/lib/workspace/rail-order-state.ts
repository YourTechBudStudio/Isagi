import { create } from 'zustand';

import type { WorkspaceData } from './model.js';
import { applyRailMove, type RailMoveIntent } from './rail-order.js';

/**
 * In-flight and failed rail reorders, keyed by sibling scope.
 *
 * This is frontend interaction state, not server state (ADR 0001): the runtime
 * owns whether a move persisted, and this owns what the rail shows while the
 * user waits and what it says if the move came back refused. It is keyed by
 * scope rather than held globally so a slow project reorder never freezes an
 * unrelated worktree's surface list.
 *
 * `movedId` rides along on both states because ADR 0004 puts feedback at the
 * action: Phase 05 needs to know *which row* in the list is the subject. A
 * pending entry also keeps the whole intent, because a snapshot that lands
 * mid-write has to be re-projected before it is installed — see
 * `applyPendingRailMoves`.
 */
export type RailOrderEntry =
  | { readonly status: 'pending'; readonly movedId: number; readonly intent: RailMoveIntent }
  | { readonly status: 'failed'; readonly movedId: number; readonly message: string };

interface RailOrderStore {
  readonly entriesByScope: Readonly<Record<string, RailOrderEntry>>;
  readonly beginRailOrder: (scopeKey: string, intent: RailMoveIntent) => void;
  readonly failRailOrder: (scopeKey: string, movedId: number, message: string) => void;
  readonly clearRailOrder: (scopeKey: string) => void;
}

export const useRailOrderStore = create<RailOrderStore>((set) => ({
  entriesByScope: {},
  // A begin also clears any earlier failure in this scope: the user has moved
  // on, and a stale refusal must not sit beside a fresh attempt.
  beginRailOrder: (scopeKey, intent) =>
    set((state) => ({
      entriesByScope: {
        ...state.entriesByScope,
        [scopeKey]: { status: 'pending', movedId: intent.movedId, intent },
      },
    })),
  failRailOrder: (scopeKey, movedId, message) =>
    set((state) => ({
      entriesByScope: {
        ...state.entriesByScope,
        [scopeKey]: { status: 'failed', movedId, message },
      },
    })),
  clearRailOrder: (scopeKey) =>
    set((state) => {
      if (!(scopeKey in state.entriesByScope)) return {};
      const next = { ...state.entriesByScope };
      delete next[scopeKey];
      return { entriesByScope: next };
    }),
}));

/**
 * Whether this list is still awaiting a persisted move. Read imperatively,
 * because the drag engine asks at `pointerdown` — outside React's render pass —
 * to decide whether to refuse the gesture. A *failed* scope is not pending: the
 * list is interactive again so the user can simply try the move once more.
 */
export function isRailOrderPending(scopeKey: string): boolean {
  return useRailOrderStore.getState().entriesByScope[scopeKey]?.status === 'pending';
}

/** True while any scope is mid-write, which gates the shared workspace refresh. */
export function anyRailOrderPending(): boolean {
  return Object.values(useRailOrderStore.getState().entriesByScope).some(
    (entry) => entry.status === 'pending',
  );
}

/**
 * Re-project every in-flight move onto a snapshot that just came off the wire.
 *
 * The reorder workflow cancels the workspace query before it projects, but that
 * only covers fetches already running: any of the app's other refresh paths — a
 * session or surface runtime event, a reconciliation completing — can start a
 * new one while a move is still being persisted, and the runtime would answer it
 * with the order from *before* the move. Installing that answer unchanged would
 * yank the dragged row back under the user's cursor, then flip it forward again
 * when the reorder's own refresh lands.
 *
 * So the fetch path replays pending intents over whatever arrives, which keeps
 * newer intent on top of older server truth for exactly as long as the write is
 * outstanding. Every other fact in the snapshot is honoured as fetched, and once
 * the move settles — accepted or refused — its entry is gone and the runtime's
 * order is again the only order.
 *
 * Total in the same way `applyRailMove` is: an intent whose row or anchor is
 * absent from the fresh snapshot changes nothing, so a move against siblings the
 * runtime has since removed simply stops being replayed.
 */
export function applyPendingRailMoves(data: WorkspaceData): WorkspaceData {
  return Object.values(useRailOrderStore.getState().entriesByScope).reduce(
    (snapshot, entry) =>
      entry.status === 'pending' ? applyRailMove(snapshot, entry.intent) : snapshot,
    data,
  );
}

/** Reactive pending state, for rendering a list as busy. */
export function useRailOrderPending(scopeKey: string): boolean {
  return useRailOrderStore((state) => state.entriesByScope[scopeKey]?.status === 'pending');
}

/** The refusal to render inline at this list, or `null` when there is none. */
export function useRailOrderFailure(
  scopeKey: string,
): Extract<RailOrderEntry, { status: 'failed' }> | null {
  return useRailOrderStore((state) => {
    const entry = state.entriesByScope[scopeKey];
    return entry?.status === 'failed' ? entry : null;
  });
}

/**
 * Dismiss a failure. Nothing expires it on a timer: a refusal the user never
 * looked at is worse than one that waits, so it is cleared by dismissal, by the
 * next reorder in this scope, or by Phase 05 when the owning list stops existing.
 */
export function clearRailOrderFailure(scopeKey: string): void {
  if (useRailOrderStore.getState().entriesByScope[scopeKey]?.status !== 'failed') return;
  useRailOrderStore.getState().clearRailOrder(scopeKey);
}
