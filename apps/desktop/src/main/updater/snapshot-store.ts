import { Effect, Option, SubscriptionRef } from 'effect';

import { DESKTOP_UPDATE_PROTOCOL_VERSION, type DesktopUpdateSnapshot } from '@isagi/contracts';

export type SnapshotFacts = DesktopUpdateSnapshot extends infer Snapshot
  ? Snapshot extends DesktopUpdateSnapshot
    ? Omit<Snapshot, 'protocolVersion' | 'revision'>
    : never
  : never;

export interface SnapshotStore {
  /** What main pushes to the renderer and answers `isagi:desktop-update` with. */
  readonly status: SubscriptionRef.SubscriptionRef<DesktopUpdateSnapshot>;
  /** The published snapshot, read synchronously by policy code that already holds the updater's lock. */
  readonly current: () => DesktopUpdateSnapshot;
  /** A publish that would change nothing is not a revision, so it is not a push. */
  readonly publish: (facts: SnapshotFacts) => Effect.Effect<void>;
}

/**
 * The published snapshot and its subscribers. Every updater composition that can change what the
 * renderer sees owns one of these, because the revision rule is the whole basis of the client's
 * subscribe-then-reconcile: a revision that fails to advance, or advances without a subscriber
 * being told, is a renderer stuck on a stale fact. One implementation, so the manual-install
 * composition cannot drift from the coordinator on it.
 *
 * The comparison and the revision bump are one `updateSome`, so publication and revision stay one
 * atomic transition.
 */
export const makeSnapshotStore = Effect.fnUntraced(function* (facts: SnapshotFacts) {
  const status = yield* SubscriptionRef.make(snapshotOf(0, facts));
  const store: SnapshotStore = {
    status,
    current: () => SubscriptionRef.getUnsafe(status),
    publish: (next) =>
      SubscriptionRef.updateSome(status, (snapshot) => {
        const candidate = snapshotOf(snapshot.revision + 1, next);
        return sameFacts(snapshot, candidate) ? Option.none() : Option.some(candidate);
      }),
  };
  return store;
});

export function snapshotOf(revision: number, facts: SnapshotFacts): DesktopUpdateSnapshot {
  return {
    protocolVersion: DESKTOP_UPDATE_PROTOCOL_VERSION,
    revision,
    ...facts,
  } as DesktopUpdateSnapshot;
}

function sameFacts(left: DesktopUpdateSnapshot, right: DesktopUpdateSnapshot) {
  const { revision: _leftRevision, ...leftFacts } = left;
  const { revision: _rightRevision, ...rightFacts } = right;
  return JSON.stringify(leftFacts) === JSON.stringify(rightFacts);
}
