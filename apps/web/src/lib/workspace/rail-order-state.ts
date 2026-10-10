import { useAtomValue } from '@effect/atom-react';
import { Atom, type AtomRegistry } from 'effect/reactivity';
import { useCallback } from 'react';

import type { WorkspaceData } from './model.js';
import { applyRailMove, type RailMoveIntent } from './rail-order.js';

/**
 * What one sibling scope says about its reorder: still being persisted, or refused.
 *
 * `movedId` rides along on both states because ADR 0004 puts feedback at the action: the rail
 * needs to know *which row* in the list is the subject. A pending entry also keeps the whole
 * intent, because the rail shows it on top of every workspace read until the runtime answers
 * (`projectRailOrder`).
 */
export type RailOrderEntry =
  | { readonly status: 'pending'; readonly movedId: number; readonly intent: RailMoveIntent }
  | { readonly status: 'failed'; readonly movedId: number; readonly message: string };

/** A move the runtime accepted whose convergence read has not landed yet. */
export interface AcceptedRailMove {
  readonly intent: RailMoveIntent;
  /** The `clock` value this acceptance produced. */
  readonly acceptedAt: number;
}

/**
 * In-flight, refused and accepted-but-unconverged rail reorders.
 *
 * This is frontend interaction state, not server state (ADR 0001): the runtime owns whether a move
 * persisted, and this owns what the rail shows while the user waits and what it says if the move
 * came back refused.
 *
 * - `entries`, keyed by sibling scope: a pending entry gates its scope (a second drop is refused)
 *   and is replayed over every read; a failed entry is the inline notice. Per scope, so a slow
 *   project reorder never freezes an unrelated worktree's surface list.
 * - `accepted`: moves the runtime accepted, replayed only over reads that *began before* the
 *   acceptance (`startedAt < acceptedAt`). Such a read cannot know the move; every later read
 *   already does, because the runtime committed before it answered.
 * - `clock`: ticks on each acceptance. A workspace read records it when it starts
 *   (`WorkspaceRead.startedAt`).
 */
export interface RailOrderState {
  readonly entries: Readonly<Record<string, RailOrderEntry>>;
  readonly accepted: readonly AcceptedRailMove[];
  readonly clock: number;
}

export const railOrderAtom = Atom.make<RailOrderState>({
  entries: {},
  accepted: [],
  clock: 0,
}).pipe(Atom.keepAlive);

/** The runtime's workspace as read, tagged with the rail clock at the moment the read began. */
export interface WorkspaceRead {
  readonly data: WorkspaceData;
  readonly startedAt: number;
}

/**
 * What the rail shows for one read under the current reorder state.
 *
 * Old reads can never undo newer moves: a pending move is replayed over every read, and an
 * accepted one over every read that began before it was accepted (later reads carry it in the
 * runtime's own order). `applyRailMove` is total, so a move whose row or anchor the read no longer
 * has changes nothing, and idempotent, so replaying a move the order already contains is harmless.
 * With nothing to replay the read's own data comes back, by reference.
 */
export function projectRailOrder(read: WorkspaceRead, rail: RailOrderState): WorkspaceData {
  let data = read.data;
  for (const accepted of rail.accepted) {
    if (read.startedAt < accepted.acceptedAt) data = applyRailMove(data, accepted.intent);
  }
  for (const entry of Object.values(rail.entries)) {
    if (entry.status === 'pending') data = applyRailMove(data, entry.intent);
  }
  return data;
}

/** True while any scope is mid-write, which defers the shared convergence read. */
export function anyRailOrderPending(rail: RailOrderState): boolean {
  return Object.values(rail.entries).some((entry) => entry.status === 'pending');
}

/**
 * Whether this list is still awaiting a persisted move. Read imperatively, because the drag engine
 * asks at `pointerdown` — outside React's render pass — to decide whether to refuse the gesture. A
 * *failed* scope is not pending: the list is interactive again so the user can simply try the move
 * once more.
 */
export function isRailOrderPending(registry: AtomRegistry.AtomRegistry, scopeKey: string): boolean {
  return registry.get(railOrderAtom).entries[scopeKey]?.status === 'pending';
}

type RailOrderFailure = Extract<RailOrderEntry, { status: 'failed' }>;

/** The refusal to render inline at this list, or `null` when there is none. */
export function useRailOrderFailure(scopeKey: string): RailOrderFailure | null {
  const select = useCallback((rail: RailOrderState) => failureAt(rail, scopeKey), [scopeKey]);
  return useAtomValue(railOrderAtom, select);
}

function failureAt(rail: RailOrderState, scopeKey: string): RailOrderFailure | null {
  const entry = rail.entries[scopeKey];
  return entry?.status === 'failed' ? entry : null;
}

/**
 * Dismiss a failure. Nothing expires it on a timer: a refusal the user never looked at is worse
 * than one that waits, so it is cleared by dismissal, by the next reorder in this scope, or by the
 * rail when the owning list stops existing.
 */
export function clearRailOrderFailure(registry: AtomRegistry.AtomRegistry, scopeKey: string): void {
  registry.update(railOrderAtom, (rail) =>
    failureAt(rail, scopeKey) === null ? rail : withoutEntry(rail, scopeKey),
  );
}

/** `rail` with this scope's entry removed (pending or failed). */
export function withoutEntry(rail: RailOrderState, scopeKey: string): RailOrderState {
  if (!(scopeKey in rail.entries)) return rail;
  const { [scopeKey]: _removed, ...entries } = rail.entries;
  return { ...rail, entries };
}
