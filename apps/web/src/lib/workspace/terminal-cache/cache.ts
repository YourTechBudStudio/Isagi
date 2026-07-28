import type { TerminalCacheSettings } from '@isagi/contracts';

import {
  estimateTerminalPresentationBytes,
  normalizeEstimatedBytes,
  type TerminalAccountingEstimator,
  type TerminalBufferMeasurement,
} from './accounting.js';
import {
  terminalPlacementKey,
  terminalPlacementsEqual,
  terminalSessionKey,
  type TerminalPlacement,
  type TerminalSessionIdentity,
} from './identity.js';
import { normalizeViewportMemory, type TerminalViewportMemory } from './viewport.js';

export type TerminalPresentationLifecycle = 'cold' | 'preparing' | 'hot' | 'sealed';
export type TerminalSealReason = 'exited' | 'moved' | 'disconnected' | 'errored' | 'superseded';

export interface TerminalPresentationResource {
  readonly dispose: () => void;
}

export interface TerminalEntrySnapshot {
  readonly key: string;
  readonly identity: TerminalSessionIdentity;
  /** `null` once another session claims this entry's pane slot; a move re-places it. */
  readonly placement: TerminalPlacement | null;
  readonly lifecycle: TerminalPresentationLifecycle;
  readonly sealReason: TerminalSealReason | null;
  readonly attachmentEpoch: number;
  /**
   * Published rendering presence. A final lease release holds the previous presence until the
   * pending-hidden handoff commits, so a reacquisition at any placement never publishes hidden.
   */
  readonly visible: boolean;
  readonly visibilityLeaseCount: number;
  readonly hiddenSince: number | null;
  readonly lastHiddenAt: number;
  readonly estimatedBytes: number;
  readonly viewport: TerminalViewportMemory | null;
}

export interface TerminalCacheSnapshot {
  readonly entries: readonly TerminalEntrySnapshot[];
  readonly totalEstimatedBytes: number;
}

export type TerminalMutationResult =
  | 'applied'
  | 'stale'
  | 'sealed'
  | 'invalid_state'
  | 'placement_mismatch';

export interface TerminalVisibilityLease {
  readonly release: () => void;
}

export type TerminalVisibilityAcquisition =
  | { readonly status: 'acquired'; readonly lease: TerminalVisibilityLease }
  | { readonly status: 'placement_mismatch' | 'stale' };

export interface TerminalAttachmentHandle {
  readonly epoch: number;
  readonly installResource: (
    resource: TerminalPresentationResource,
    measurement: TerminalBufferMeasurement,
  ) => TerminalMutationResult;
  readonly updateMeasurement: (measurement: TerminalBufferMeasurement) => TerminalMutationResult;
  readonly markReady: () => TerminalMutationResult;
  readonly seal: (reason: TerminalSealReason) => TerminalMutationResult;
  readonly abortPreparation: () => TerminalMutationResult;
  readonly isCurrentMutable: () => boolean;
}

export type TerminalAttachmentStart =
  | { readonly status: 'started'; readonly attachment: TerminalAttachmentHandle }
  | { readonly status: 'stale' };

export interface TerminalSessionHandle {
  readonly identity: TerminalSessionIdentity;
  readonly acquireVisibility: (placement: TerminalPlacement) => TerminalVisibilityAcquisition;
  readonly movePlacement: (placement: TerminalPlacement) => TerminalMutationResult;
  readonly beginAttachment: () => TerminalAttachmentStart;
  readonly updateViewport: (viewport: TerminalViewportMemory) => TerminalMutationResult;
  readonly evictPresentation: () => TerminalMutationResult;
  readonly invalidate: () => TerminalMutationResult;
}

export type TerminalCacheDiagnostic =
  | {
      readonly kind: 'operation_rejected';
      readonly operation: string;
      readonly identityKey: string;
      readonly result: Exclude<TerminalMutationResult, 'applied'>;
    }
  | {
      readonly kind: 'resource_dispose_failed';
      readonly operation: string;
      readonly identityKey: string;
      readonly error: unknown;
    }
  | {
      readonly kind: 'placement_displaced';
      readonly operation: string;
      readonly identityKey: string;
      readonly placement: TerminalPlacement;
    };

export interface TerminalCacheDependencies {
  readonly settings: TerminalCacheSettings;
  readonly now?: (() => number) | undefined;
  readonly scheduleMicrotask?: ((callback: () => void) => () => void) | undefined;
  readonly estimateBytes?: TerminalAccountingEstimator | undefined;
  readonly onDiagnostic?: ((diagnostic: TerminalCacheDiagnostic) => void) | undefined;
}

export interface TerminalPresentationCache {
  readonly settings: TerminalCacheSettings;
  readonly ensureSession: (
    identity: TerminalSessionIdentity,
    initialPlacement: TerminalPlacement,
  ) => TerminalSessionHandle;
  readonly getSessionAtPlacement: (placement: TerminalPlacement) => TerminalSessionHandle | null;
  readonly sweepLiveSessions: (identities: readonly TerminalSessionIdentity[]) => void;
  readonly getSnapshot: () => TerminalCacheSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly dispose: () => void;
}

interface InstalledResource {
  readonly value: TerminalPresentationResource;
  disposed: boolean;
}

interface LeaseState {
  owning: boolean;
  released: boolean;
}

interface AttachmentState {
  readonly token: symbol;
  readonly epoch: number;
  active: boolean;
}

/** The last published rendering presence, which the pending-hidden handoff deliberately holds. */
interface PresenceState {
  visible: boolean;
  leaseCount: number;
}

interface EntryState {
  readonly key: string;
  readonly identity: TerminalSessionIdentity;
  placement: TerminalPlacement | null;
  /** True only while caller-owned disposal runs; closes the entry to re-entrant mutation. */
  transitioning: boolean;
  lifecycle: TerminalPresentationLifecycle;
  sealReason: TerminalSealReason | null;
  attachmentEpoch: number;
  attachment: AttachmentState | null;
  resource: InstalledResource | null;
  leases: Set<LeaseState>;
  owningLeaseCount: number;
  presence: PresenceState;
  hiddenSince: number | null;
  lastHiddenAt: number;
  pendingHidden: { readonly releasedAt: number; readonly cancel: () => void } | null;
  estimatedBytes: number;
  viewport: TerminalViewportMemory | null;
  alive: boolean;
}

const emptySnapshot: TerminalCacheSnapshot = Object.freeze({
  entries: Object.freeze([]),
  totalEstimatedBytes: 0,
});

export function createTerminalPresentationCache(
  dependencies: TerminalCacheDependencies,
): TerminalPresentationCache {
  const settings = Object.freeze({ ...dependencies.settings });
  const now = dependencies.now ?? Date.now;
  const scheduleMicrotask = dependencies.scheduleMicrotask ?? defaultMicrotaskScheduler;
  const estimateBytes = dependencies.estimateBytes ?? estimateTerminalPresentationBytes;
  const entries = new Map<string, EntryState>();
  const placements = new Map<string, EntryState>();
  const listeners = new Set<() => void>();
  let snapshot = emptySnapshot;
  let disposed = false;
  let transactionDepth = 0;
  let publishPending = false;
  const pendingDiagnostics: TerminalCacheDiagnostic[] = [];

  /** A diagnostic sink is an observer: its failures never reach cache state or the caller. */
  const deliverDiagnostic = (diagnostic: TerminalCacheDiagnostic) => {
    try {
      dependencies.onDiagnostic?.(diagnostic);
    } catch {
      // Intentionally swallowed; there is no second channel to report a reporting failure on.
    }
  };

  /**
   * Diagnostics describe operations, they do not participate in them. Inside a transaction they
   * are queued and delivered once state is committed, so a sink can never observe or re-enter a
   * half-applied mutation.
   */
  const diagnose = (diagnostic: TerminalCacheDiagnostic) => {
    if (transactionDepth > 0) {
      pendingDiagnostics.push(diagnostic);
      return;
    }
    deliverDiagnostic(diagnostic);
  };

  const emit = () => {
    snapshot = buildSnapshot(entries);
    for (const listener of listeners) {
      listener();
    }
  };

  /**
   * One atomic snapshot boundary per outermost operation. Nested work — including a caller-owned
   * disposer that re-enters the cache and transitions another entry — folds into the outer
   * boundary, so subscribers never observe a half-completed transition.
   */
  const inTransaction = <Result>(run: () => Result): Result => {
    transactionDepth += 1;
    try {
      return run();
    } finally {
      transactionDepth -= 1;
      if (transactionDepth === 0) {
        if (publishPending) {
          publishPending = false;
          emit();
        }
        for (const diagnostic of pendingDiagnostics.splice(0)) {
          deliverDiagnostic(diagnostic);
        }
      }
    }
  };

  const publish = () => {
    if (transactionDepth > 0) {
      publishPending = true;
      return;
    }
    emit();
  };

  const reject = (
    entry: Pick<EntryState, 'key'>,
    operation: string,
    result: Exclude<TerminalMutationResult, 'applied'>,
  ): Exclude<TerminalMutationResult, 'applied'> => {
    diagnose({ kind: 'operation_rejected', operation, identityKey: entry.key, result });
    return result;
  };

  const invalidateAttachment = (entry: EntryState) => {
    if (entry.attachment) {
      entry.attachment.active = false;
      entry.attachment = null;
    }
  };

  /**
   * Ends the current presentation: attachment authority is revoked and resource ownership is
   * dropped before any caller-owned code runs, and the entry is closed to further mutation for the
   * duration of `dispose()`. A disposer that re-enters the cache therefore cannot start a nested
   * epoch, install into the slot being torn down, or publish an intermediate state, and a throwing
   * disposer cannot abort the surrounding transition. Releasing a visibility lease is cleanup
   * rather than mutation and stays accounted; only its publication waits for the transition.
   */
  const releasePresentation = (entry: EntryState, operation: string) => {
    invalidateAttachment(entry);
    const installed = entry.resource;
    entry.resource = null;
    entry.estimatedBytes = 0;
    if (!installed || installed.disposed) {
      return;
    }
    installed.disposed = true;
    entry.transitioning = true;
    inTransaction(() => {
      try {
        installed.value.dispose();
      } catch (error) {
        diagnose({ kind: 'resource_dispose_failed', operation, identityKey: entry.key, error });
      } finally {
        entry.transitioning = false;
      }
    });
  };

  const cancelPendingHidden = (entry: EntryState) => {
    entry.pendingHidden?.cancel();
    entry.pendingHidden = null;
  };

  /**
   * Brings published presence up to date with real lease ownership and reports whether anything
   * changed. Presence is frozen while a pending-hidden handoff is in flight so relocation and
   * StrictMode probes never publish a hidden state that consumers would act on.
   */
  const syncPresence = (entry: EntryState): boolean => {
    if (entry.pendingHidden) {
      return false;
    }
    const visible = entry.owningLeaseCount > 0;
    if (
      entry.presence.visible === visible &&
      entry.presence.leaseCount === entry.owningLeaseCount
    ) {
      return false;
    }
    entry.presence.visible = visible;
    entry.presence.leaseCount = entry.owningLeaseCount;
    return true;
  };

  const scheduleHidden = (entry: EntryState, releasedAt: number) => {
    cancelPendingHidden(entry);
    let canceled = false;
    const cancelScheduled = scheduleMicrotask(() => {
      if (canceled || !entry.alive || entry.owningLeaseCount !== 0) {
        return;
      }
      entry.pendingHidden = null;
      entry.hiddenSince = releasedAt;
      entry.lastHiddenAt = releasedAt;
      syncPresence(entry);
      publish();
    });
    const cancel = () => {
      if (canceled) {
        return;
      }
      canceled = true;
      cancelScheduled();
    };
    entry.pendingHidden = { releasedAt, cancel };
  };

  /** Cleanup authority: the entry still exists, even if a transition is rejecting mutations. */
  const entryIsLive = (entry: EntryState) =>
    !disposed && entry.alive && entries.get(entry.key) === entry;

  /** Mutation authority: additionally requires that no caller-owned disposal is in flight. */
  const entryIsCurrent = (entry: EntryState) => entryIsLive(entry) && !entry.transitioning;

  /** Drops real lease ownership while leaving published presence to the pending-hidden handoff. */
  const releaseVisibilityOwnership = (entry: EntryState) => {
    const wasOwned = entry.owningLeaseCount > 0;
    for (const lease of entry.leases) lease.owning = false;
    entry.owningLeaseCount = 0;
    if (wasOwned) {
      scheduleHidden(entry, now());
    } else {
      syncPresence(entry);
    }
  };

  /**
   * A pane slot hosts at most one durable session. Claiming an occupied placement unplaces the
   * previous holder rather than leaving two entries claiming the same slot: it loses the placement,
   * can no longer acquire visibility there, and hands its published presence off to the new holder.
   */
  const claimPlacement = (entry: EntryState, placement: TerminalPlacement, operation: string) => {
    const key = terminalPlacementKey(placement);
    const holder = placements.get(key);
    if (holder && holder !== entry) {
      holder.placement = null;
      releaseVisibilityOwnership(holder);
    }
    entry.placement = Object.freeze({ ...placement });
    placements.set(key, entry);
    // Reported only once the slot has exactly one owner again.
    if (holder && holder !== entry) {
      diagnose({
        kind: 'placement_displaced',
        operation,
        identityKey: holder.key,
        placement: entry.placement,
      });
    }
  };

  const releasePlacement = (entry: EntryState) => {
    if (!entry.placement) return;
    const key = terminalPlacementKey(entry.placement);
    if (placements.get(key) === entry) {
      placements.delete(key);
    }
  };

  const attachmentResult = (
    entry: EntryState,
    attachment: AttachmentState,
    operation: string,
  ): Exclude<TerminalMutationResult, 'applied'> | null => {
    if (!entryIsCurrent(entry) || entry.attachment?.token !== attachment.token) {
      return reject(entry, operation, 'stale');
    }
    if (entry.lifecycle === 'sealed') {
      return reject(entry, operation, 'sealed');
    }
    if (!attachment.active) {
      return reject(entry, operation, 'stale');
    }
    return null;
  };

  const createAttachmentHandle = (
    entry: EntryState,
    attachment: AttachmentState,
  ): TerminalAttachmentHandle => ({
    epoch: attachment.epoch,
    installResource(resource, measurement) {
      const rejected = attachmentResult(entry, attachment, 'install_resource');
      if (rejected) return rejected;
      if (entry.lifecycle !== 'preparing' || entry.resource) {
        return reject(entry, 'install_resource', 'invalid_state');
      }
      // Estimate before taking ownership so invalid input cannot leave a half-installed resource.
      const estimatedBytes = normalizeEstimatedBytes(estimateBytes(measurement));
      entry.resource = { value: resource, disposed: false };
      entry.estimatedBytes = estimatedBytes;
      publish();
      return 'applied';
    },
    updateMeasurement(measurement) {
      const rejected = attachmentResult(entry, attachment, 'update_measurement');
      if (rejected) return rejected;
      if (!entry.resource || (entry.lifecycle !== 'preparing' && entry.lifecycle !== 'hot')) {
        return reject(entry, 'update_measurement', 'invalid_state');
      }
      const estimatedBytes = normalizeEstimatedBytes(estimateBytes(measurement));
      if (entry.estimatedBytes === estimatedBytes) return 'applied';
      entry.estimatedBytes = estimatedBytes;
      publish();
      return 'applied';
    },
    markReady() {
      const rejected = attachmentResult(entry, attachment, 'mark_ready');
      if (rejected) return rejected;
      if (entry.lifecycle !== 'preparing' || !entry.resource) {
        return reject(entry, 'mark_ready', 'invalid_state');
      }
      entry.lifecycle = 'hot';
      publish();
      return 'applied';
    },
    seal(reason) {
      const rejected = attachmentResult(entry, attachment, 'seal');
      if (rejected) return rejected;
      if (entry.lifecycle !== 'preparing' && entry.lifecycle !== 'hot') {
        return reject(entry, 'seal', 'invalid_state');
      }
      entry.lifecycle = 'sealed';
      entry.sealReason = reason;
      attachment.active = false;
      publish();
      return 'applied';
    },
    abortPreparation() {
      const rejected = attachmentResult(entry, attachment, 'abort_preparation');
      if (rejected) return rejected;
      if (entry.lifecycle !== 'preparing') {
        return reject(entry, 'abort_preparation', 'invalid_state');
      }
      return inTransaction(() => {
        releasePresentation(entry, 'abort_preparation');
        entry.lifecycle = 'cold';
        entry.sealReason = null;
        publish();
        return 'applied';
      });
    },
    isCurrentMutable() {
      return attachmentResult(entry, attachment, 'is_current_mutable') === null;
    },
  });

  const createSessionHandle = (entry: EntryState): TerminalSessionHandle => ({
    identity: entry.identity,
    acquireVisibility(placement) {
      if (!entryIsCurrent(entry)) {
        reject(entry, 'acquire_visibility', 'stale');
        return { status: 'stale' };
      }
      if (!entry.placement || !terminalPlacementsEqual(entry.placement, placement)) {
        reject(entry, 'acquire_visibility', 'placement_mismatch');
        return { status: 'placement_mismatch' };
      }
      const lease: LeaseState = { owning: true, released: false };
      entry.leases.add(lease);
      entry.owningLeaseCount += 1;
      cancelPendingHidden(entry);
      if (!entry.presence.visible) {
        entry.hiddenSince = null;
      }
      if (syncPresence(entry)) publish();
      return {
        status: 'acquired',
        lease: {
          release() {
            if (lease.released) return;
            lease.released = true;
            entry.leases.delete(lease);
            if (!lease.owning) return;
            lease.owning = false;
            // Releasing is cleanup, so it is accounted exactly once even mid-teardown; an entry
            // that is already gone reset its own accounting when it died.
            if (!entryIsLive(entry)) return;
            entry.owningLeaseCount -= 1;
            if (entry.owningLeaseCount === 0) {
              // Hold the published presence for one task so a reacquisition avoids churn.
              scheduleHidden(entry, now());
              return;
            }
            if (syncPresence(entry)) publish();
          },
        },
      };
    },
    movePlacement(placement) {
      if (!entryIsCurrent(entry)) return reject(entry, 'move_placement', 'stale');
      if (entry.placement && terminalPlacementsEqual(entry.placement, placement)) return 'applied';
      return inTransaction(() => {
        releasePlacement(entry);
        // Relocation is a visibility transfer: presence stays published until the handoff commits.
        releaseVisibilityOwnership(entry);
        claimPlacement(entry, placement, 'move_placement');
        publish();
        return 'applied';
      });
    },
    beginAttachment() {
      if (!entryIsCurrent(entry)) {
        reject(entry, 'begin_attachment', 'stale');
        return { status: 'stale' };
      }
      return inTransaction<TerminalAttachmentStart>(() => {
        releasePresentation(entry, 'begin_attachment');
        entry.attachmentEpoch += 1;
        const attachment: AttachmentState = {
          token: Symbol(`terminal-attachment-${entry.key}-${entry.attachmentEpoch}`),
          epoch: entry.attachmentEpoch,
          active: true,
        };
        entry.attachment = attachment;
        entry.lifecycle = 'preparing';
        entry.sealReason = null;
        publish();
        return { status: 'started', attachment: createAttachmentHandle(entry, attachment) };
      });
    },
    updateViewport(viewport) {
      if (!entryIsCurrent(entry)) return reject(entry, 'update_viewport', 'stale');
      entry.viewport = normalizeViewportMemory(viewport);
      publish();
      return 'applied';
    },
    evictPresentation() {
      if (!entryIsCurrent(entry)) return reject(entry, 'evict_presentation', 'stale');
      if (entry.presence.visible || entry.owningLeaseCount > 0) {
        return reject(entry, 'evict_presentation', 'invalid_state');
      }
      if (entry.lifecycle === 'cold') return 'applied';
      return inTransaction(() => {
        releasePresentation(entry, 'evict_presentation');
        entry.lifecycle = 'cold';
        entry.sealReason = null;
        publish();
        return 'applied';
      });
    },
    invalidate() {
      if (!entryIsCurrent(entry)) return reject(entry, 'invalidate', 'stale');
      return inTransaction(() => {
        removeEntry(entry, 'invalidate');
        publish();
        return 'applied';
      });
    },
  });

  const invalidateEntry = (entry: EntryState, operation: string) => {
    cancelPendingHidden(entry);
    // Kill the entry before caller-owned disposal so a re-entrant disposer cannot revive it.
    entry.alive = false;
    releasePresentation(entry, operation);
    for (const lease of entry.leases) lease.owning = false;
    entry.leases.clear();
    entry.owningLeaseCount = 0;
    entry.presence.visible = false;
    entry.presence.leaseCount = 0;
    entry.viewport = null;
  };

  const removeEntry = (entry: EntryState, operation: string) => {
    invalidateEntry(entry, operation);
    releasePlacement(entry);
    entries.delete(entry.key);
  };

  const createEntry = (
    key: string,
    identity: TerminalSessionIdentity,
    initialPlacement: TerminalPlacement,
  ): TerminalSessionHandle => {
    const createdAt = now();
    const entry: EntryState = {
      key,
      identity: Object.freeze({ ...identity }),
      placement: null,
      transitioning: false,
      lifecycle: 'cold',
      sealReason: null,
      attachmentEpoch: 0,
      attachment: null,
      resource: null,
      leases: new Set(),
      owningLeaseCount: 0,
      presence: { visible: false, leaseCount: 0 },
      hiddenSince: createdAt,
      lastHiddenAt: createdAt,
      pendingHidden: null,
      estimatedBytes: 0,
      viewport: null,
      alive: true,
    };
    entries.set(key, entry);
    claimPlacement(entry, initialPlacement, 'ensure_session');
    publish();
    return createSessionHandle(entry);
  };

  return {
    settings,
    ensureSession(identity, initialPlacement) {
      if (disposed) {
        throw new Error('Cannot ensure a session on a disposed terminal presentation cache.');
      }
      const key = terminalSessionKey(identity);
      const existing = entries.get(key);
      if (existing) return createSessionHandle(existing);
      return inTransaction(() => createEntry(key, identity, initialPlacement));
    },
    getSessionAtPlacement(placement) {
      if (disposed) return null;
      const entry = placements.get(terminalPlacementKey(placement));
      if (!entry || !entryIsCurrent(entry)) return null;
      return createSessionHandle(entry);
    },
    sweepLiveSessions(identities) {
      if (disposed) return;
      const liveKeys = new Set(identities.map(terminalSessionKey));
      inTransaction(() => {
        let changed = false;
        for (const entry of [...entries.values()]) {
          if (!liveKeys.has(entry.key)) {
            removeEntry(entry, 'sweep_live_sessions');
            changed = true;
          }
        }
        if (changed) publish();
      });
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(listener);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      inTransaction(() => {
        // Every entry is cleaned up even if an individual resource disposal reports a failure.
        for (const entry of entries.values()) invalidateEntry(entry, 'dispose');
        entries.clear();
        placements.clear();
        // Teardown owns the final notification, so no deferred publish may follow it.
        publishPending = false;
        snapshot = emptySnapshot;
        for (const listener of listeners) listener();
        listeners.clear();
      });
    },
  };
}

function buildSnapshot(entries: ReadonlyMap<string, EntryState>): TerminalCacheSnapshot {
  const snapshots = [...entries.values()]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map<TerminalEntrySnapshot>((entry) =>
      Object.freeze({
        key: entry.key,
        identity: entry.identity,
        placement: entry.placement,
        lifecycle: entry.lifecycle,
        sealReason: entry.sealReason,
        attachmentEpoch: entry.attachmentEpoch,
        visible: entry.presence.visible,
        visibilityLeaseCount: entry.presence.leaseCount,
        hiddenSince: entry.hiddenSince,
        lastHiddenAt: entry.lastHiddenAt,
        estimatedBytes: entry.estimatedBytes,
        viewport: entry.viewport,
      }),
    );
  return Object.freeze({
    entries: Object.freeze(snapshots),
    totalEstimatedBytes: snapshots.reduce((total, entry) => total + entry.estimatedBytes, 0),
  });
}

function defaultMicrotaskScheduler(callback: () => void): () => void {
  let canceled = false;
  queueMicrotask(() => {
    if (!canceled) callback();
  });
  return () => {
    canceled = true;
  };
}
