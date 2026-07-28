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
import { terminalRetentionCandidates } from './policy.js';
import { normalizeViewportMemory, type TerminalViewportMemory } from './viewport.js';

export type TerminalPresentationLifecycle = 'cold' | 'preparing' | 'hot' | 'sealed';
export type TerminalSealReason = 'exited' | 'moved' | 'disconnected' | 'errored' | 'superseded';

export interface TerminalPresentationResource {
  readonly dispose: () => void;
}

export interface TerminalEntrySnapshot {
  readonly key: string;
  readonly identity: TerminalSessionIdentity;
  readonly worktreeId: number;
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

export interface TerminalSessionEnsureResult<
  Resource extends TerminalPresentationResource,
> extends TerminalSessionHandle<Resource> {
  readonly status: 'ensured' | 'scope_mismatch';
}

/** Opaque authority for conditionally invalidating only the incarnation observed by a caller. */
export interface TerminalEntryIncarnation {
  readonly identity: TerminalSessionIdentity;
  readonly worktreeId: number;
  readonly invalidateIfCurrent: () => TerminalMutationResult;
}

export interface TerminalVisibilityLease {
  readonly release: () => void;
}

export type TerminalVisibilityAcquisition<
  Resource extends TerminalPresentationResource = TerminalPresentationResource,
> =
  | {
      readonly status: 'acquired';
      readonly lease: TerminalVisibilityLease;
      readonly resource: Resource | null;
    }
  | { readonly status: 'placement_mismatch' | 'stale' };

export interface TerminalAttachmentHandle<
  Resource extends TerminalPresentationResource = TerminalPresentationResource,
> {
  readonly epoch: number;
  readonly installResource: (
    resource: Resource,
    measurement: TerminalBufferMeasurement,
  ) => TerminalMutationResult;
  readonly updateMeasurement: (measurement: TerminalBufferMeasurement) => TerminalMutationResult;
  readonly markReady: () => TerminalMutationResult;
  readonly seal: (reason: TerminalSealReason) => TerminalMutationResult;
  readonly abortPreparation: () => TerminalMutationResult;
  readonly isCurrentMutable: () => boolean;
}

export type TerminalAttachmentStart<
  Resource extends TerminalPresentationResource = TerminalPresentationResource,
> =
  | { readonly status: 'started'; readonly attachment: TerminalAttachmentHandle<Resource> }
  | { readonly status: 'stale' };

export interface TerminalSessionHandle<
  Resource extends TerminalPresentationResource = TerminalPresentationResource,
> {
  readonly identity: TerminalSessionIdentity;
  readonly worktreeId: number;
  readonly acquireVisibility: (
    placement: TerminalPlacement,
  ) => TerminalVisibilityAcquisition<Resource>;
  readonly movePlacement: (placement: TerminalPlacement) => TerminalMutationResult;
  readonly unplace: () => TerminalMutationResult;
  readonly beginAttachment: () => TerminalAttachmentStart<Resource>;
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
      readonly reason: 'resource_dispose_threw';
    }
  | {
      readonly kind: 'placement_displaced';
      readonly operation: string;
      readonly identityKey: string;
      readonly placement: TerminalPlacement;
    }
  | {
      readonly kind: 'scope_mismatch';
      readonly operation: 'ensure_session' | 'move_placement' | 'delete_event';
      readonly identityKey: string;
      readonly expectedWorktreeId: number;
      readonly receivedWorktreeId: number;
    }
  | {
      readonly kind: 'presentation_evicted';
      readonly identityKey: string;
      readonly reason: 'ttl' | 'hidden_count' | 'memory_budget';
      readonly estimatedBytes: number;
    }
  | {
      readonly kind: 'visible_only_overage';
      readonly estimatedBytes: number;
      readonly budgetBytes: number;
    };

export interface TerminalCacheDependencies {
  readonly settings: TerminalCacheSettings;
  readonly now?: (() => number) | undefined;
  readonly scheduleMicrotask?: ((callback: () => void) => () => void) | undefined;
  readonly scheduleTimer?: ((delayMs: number, callback: () => void) => () => void) | undefined;
  readonly estimateBytes?: TerminalAccountingEstimator | undefined;
  readonly onDiagnostic?: ((diagnostic: TerminalCacheDiagnostic) => void) | undefined;
}

export interface TerminalPresentationCache<
  Resource extends TerminalPresentationResource = TerminalPresentationResource,
> {
  readonly settings: TerminalCacheSettings;
  readonly ensureSession: (
    identity: TerminalSessionIdentity,
    initialPlacement: TerminalPlacement,
  ) => TerminalSessionEnsureResult<Resource>;
  readonly getSessionAtPlacement: (
    placement: TerminalPlacement,
  ) => TerminalSessionHandle<Resource> | null;
  readonly getSession: (
    identity: TerminalSessionIdentity,
  ) => TerminalSessionHandle<Resource> | null;
  readonly captureIncarnations: () => readonly TerminalEntryIncarnation[];
  readonly invalidateWorktree: (worktreeId: number) => void;
  readonly getSnapshot: () => TerminalCacheSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly subscribeMembership: (listener: () => void) => () => void;
  readonly dispose: () => void;
}

interface InstalledResource<Resource extends TerminalPresentationResource> {
  readonly value: Resource;
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

interface EntryState<Resource extends TerminalPresentationResource> {
  readonly key: string;
  readonly identity: TerminalSessionIdentity;
  readonly worktreeId: number;
  readonly incarnation: symbol;
  placement: TerminalPlacement | null;
  /** True only while caller-owned disposal runs; closes the entry to re-entrant mutation. */
  transitioning: boolean;
  lifecycle: TerminalPresentationLifecycle;
  sealReason: TerminalSealReason | null;
  attachmentEpoch: number;
  attachment: AttachmentState | null;
  resource: InstalledResource<Resource> | null;
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

export function createTerminalPresentationCache<
  Resource extends TerminalPresentationResource = TerminalPresentationResource,
>(dependencies: TerminalCacheDependencies): TerminalPresentationCache<Resource> {
  const settings = Object.freeze({ ...dependencies.settings });
  const now = dependencies.now ?? Date.now;
  const scheduleMicrotask = dependencies.scheduleMicrotask ?? defaultMicrotaskScheduler;
  const scheduleTimer = dependencies.scheduleTimer ?? defaultTimerScheduler;
  const estimateBytes = dependencies.estimateBytes ?? estimateTerminalPresentationBytes;
  const entries = new Map<string, EntryState<Resource>>();
  const placements = new Map<string, EntryState<Resource>>();
  const listeners = new Set<() => void>();
  const membershipListeners = new Set<() => void>();
  let snapshot = emptySnapshot;
  let disposed = false;
  let transactionDepth = 0;
  let publishPending = false;
  let retentionCancel: (() => void) | null = null;
  let retentionGeneration = 0;
  let enforcementQueued = false;
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
  const emitMembership = () => {
    for (const listener of membershipListeners) listener();
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
    entry: Pick<EntryState<Resource>, 'key'>,
    operation: string,
    result: Exclude<TerminalMutationResult, 'applied'>,
  ): Exclude<TerminalMutationResult, 'applied'> => {
    diagnose({ kind: 'operation_rejected', operation, identityKey: entry.key, result });
    return result;
  };

  const invalidateAttachment = (entry: EntryState<Resource>) => {
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
  const releasePresentation = (entry: EntryState<Resource>, operation: string) => {
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
      } catch {
        diagnose({
          kind: 'resource_dispose_failed',
          operation,
          identityKey: entry.key,
          reason: 'resource_dispose_threw',
        });
      } finally {
        entry.transitioning = false;
      }
    });
  };

  const cancelPendingHidden = (entry: EntryState<Resource>) => {
    entry.pendingHidden?.cancel();
    entry.pendingHidden = null;
  };

  /**
   * Brings published presence up to date with real lease ownership and reports whether anything
   * changed. Presence is frozen while a pending-hidden handoff is in flight so relocation and
   * StrictMode probes never publish a hidden state that consumers would act on.
   */
  const syncPresence = (entry: EntryState<Resource>): boolean => {
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

  const scheduleHidden = (entry: EntryState<Resource>, releasedAt: number) => {
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
      queueRetentionEnforcement();
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
  const entryIsLive = (entry: EntryState<Resource>) =>
    !disposed && entry.alive && entries.get(entry.key) === entry;

  /** Mutation authority: additionally requires that no caller-owned disposal is in flight. */
  const entryIsCurrent = (entry: EntryState<Resource>) =>
    entryIsLive(entry) && !entry.transitioning;

  /** Drops real lease ownership while leaving published presence to the pending-hidden handoff. */
  const releaseVisibilityOwnership = (entry: EntryState<Resource>) => {
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
  const claimPlacement = (
    entry: EntryState<Resource>,
    placement: TerminalPlacement,
    operation: string,
  ) => {
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

  const releasePlacement = (entry: EntryState<Resource>) => {
    if (!entry.placement) return;
    const key = terminalPlacementKey(entry.placement);
    if (placements.get(key) === entry) {
      placements.delete(key);
    }
  };

  const attachmentResult = (
    entry: EntryState<Resource>,
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
    entry: EntryState<Resource>,
    attachment: AttachmentState,
  ): TerminalAttachmentHandle<Resource> => ({
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
      queueRetentionEnforcement();
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
      queueRetentionEnforcement();
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
      return (
        entryIsCurrent(entry) &&
        entry.attachment?.token === attachment.token &&
        attachment.active &&
        entry.lifecycle !== 'sealed'
      );
    },
  });

  const createSessionHandle = (entry: EntryState<Resource>): TerminalSessionHandle<Resource> => ({
    identity: entry.identity,
    worktreeId: entry.worktreeId,
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
        resource: entry.resource?.value ?? null,
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
      if (placement.worktreeId !== entry.worktreeId) {
        diagnose({
          kind: 'scope_mismatch',
          operation: 'move_placement',
          identityKey: entry.key,
          expectedWorktreeId: entry.worktreeId,
          receivedWorktreeId: placement.worktreeId,
        });
        return 'placement_mismatch';
      }
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
    unplace() {
      if (!entryIsCurrent(entry)) return reject(entry, 'unplace', 'stale');
      if (!entry.placement) return 'applied';
      return inTransaction(() => {
        releasePlacement(entry);
        entry.placement = null;
        releaseVisibilityOwnership(entry);
        publish();
        return 'applied';
      });
    },
    beginAttachment() {
      if (!entryIsCurrent(entry)) {
        reject(entry, 'begin_attachment', 'stale');
        return { status: 'stale' };
      }
      return inTransaction<TerminalAttachmentStart<Resource>>(() => {
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

  const invalidateEntry = (entry: EntryState<Resource>, operation: string) => {
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

  const removeEntry = (entry: EntryState<Resource>, operation: string) => {
    invalidateEntry(entry, operation);
    releasePlacement(entry);
    entries.delete(entry.key);
    emitMembership();
  };

  const createEntry = (
    key: string,
    identity: TerminalSessionIdentity,
    initialPlacement: TerminalPlacement,
  ): TerminalSessionEnsureResult<Resource> => {
    const createdAt = now();
    const entry: EntryState<Resource> = {
      key,
      identity: Object.freeze({ ...identity }),
      worktreeId: initialPlacement.worktreeId,
      incarnation: Symbol(key),
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
    emitMembership();
    claimPlacement(entry, initialPlacement, 'ensure_session');
    publish();
    return { status: 'ensured', ...createSessionHandle(entry) };
  };

  const scopeMismatchHandle = (
    identity: TerminalSessionIdentity,
    worktreeId: number,
  ): TerminalSessionEnsureResult<Resource> => ({
    status: 'scope_mismatch',
    identity: Object.freeze({ ...identity }),
    worktreeId,
    acquireVisibility: () => ({ status: 'stale' }),
    movePlacement: () => 'stale',
    unplace: () => 'stale',
    beginAttachment: () => ({ status: 'stale' }),
    updateViewport: () => 'stale',
    evictPresentation: () => 'stale',
    invalidate: () => 'stale',
  });

  const enforceRetention = () => {
    if (disposed) return;
    retentionCancel?.();
    retentionCancel = null;
    const generation = ++retentionGeneration;
    inTransaction(() => {
      const candidates = terminalRetentionCandidates(buildSnapshot(entries), settings, now());
      for (const candidate of candidates) {
        const entry = entries.get(candidate.key);
        if (!entry || entry.presence.visible || !entry.resource) continue;
        const ttlMs = settings.idleTtlMinutes * 60_000;
        const reason =
          ttlMs === 0 || now() - (entry.hiddenSince ?? now()) >= ttlMs
            ? 'ttl'
            : buildSnapshot(entries).totalEstimatedBytes >
                settings.maxEstimatedBufferMiB * 1024 * 1024
              ? 'memory_budget'
              : 'hidden_count';
        diagnose({
          kind: 'presentation_evicted',
          identityKey: entry.key,
          reason,
          estimatedBytes: entry.estimatedBytes,
        });
        releasePresentation(entry, 'retention');
        entry.lifecycle = 'cold';
        entry.sealReason = null;
      }
      if (candidates.length > 0) publish();
      const current = buildSnapshot(entries);
      const budgetBytes = settings.maxEstimatedBufferMiB * 1024 * 1024;
      const visibleBytes = current.entries
        .filter((entry) => entry.visible)
        .reduce((total, entry) => total + entry.estimatedBytes, 0);
      if (visibleBytes > budgetBytes) {
        diagnose({ kind: 'visible_only_overage', estimatedBytes: visibleBytes, budgetBytes });
      }
    });
    const ttlMs = settings.idleTtlMinutes * 60_000;
    if (ttlMs === 0) return;
    const next = [...entries.values()]
      .filter((entry) => !entry.presence.visible && entry.resource && entry.hiddenSince !== null)
      .reduce<number | null>((minimum, entry) => {
        const expiry = (entry.hiddenSince ?? now()) + ttlMs;
        return minimum === null ? expiry : Math.min(minimum, expiry);
      }, null);
    if (next === null) return;
    retentionCancel = scheduleTimer(Math.max(0, next - now()), () => {
      if (disposed || generation !== retentionGeneration) return;
      enforceRetention();
    });
  };

  function queueRetentionEnforcement() {
    if (disposed || enforcementQueued) return;
    enforcementQueued = true;
    scheduleMicrotask(() => {
      enforcementQueued = false;
      enforceRetention();
    });
  }

  return {
    settings,
    ensureSession(identity, initialPlacement) {
      if (disposed) {
        throw new Error('Cannot ensure a session on a disposed terminal presentation cache.');
      }
      const key = terminalSessionKey(identity);
      const existing = entries.get(key);
      if (existing) {
        if (existing.worktreeId !== initialPlacement.worktreeId) {
          diagnose({
            kind: 'scope_mismatch',
            operation: 'ensure_session',
            identityKey: key,
            expectedWorktreeId: existing.worktreeId,
            receivedWorktreeId: initialPlacement.worktreeId,
          });
          return scopeMismatchHandle(identity, initialPlacement.worktreeId);
        }
        return { status: 'ensured', ...createSessionHandle(existing) };
      }
      return inTransaction(() => createEntry(key, identity, initialPlacement));
    },
    getSessionAtPlacement(placement) {
      if (disposed) return null;
      const entry = placements.get(terminalPlacementKey(placement));
      if (!entry || !entryIsCurrent(entry)) return null;
      return createSessionHandle(entry);
    },
    getSession(identity) {
      if (disposed) return null;
      const entry = entries.get(terminalSessionKey(identity));
      return entry && entryIsCurrent(entry) ? createSessionHandle(entry) : null;
    },
    captureIncarnations() {
      if (disposed) return [];
      return [...entries.values()].map((entry) => ({
        identity: entry.identity,
        worktreeId: entry.worktreeId,
        invalidateIfCurrent: () => {
          if (!entryIsCurrent(entry) || entries.get(entry.key)?.incarnation !== entry.incarnation) {
            return 'stale';
          }
          return inTransaction(() => {
            removeEntry(entry, 'conditional_invalidate');
            publish();
            return 'applied';
          });
        },
      }));
    },
    invalidateWorktree(worktreeId) {
      if (disposed) return;
      inTransaction(() => {
        let changed = false;
        for (const entry of [...entries.values()]) {
          if (entry.worktreeId === worktreeId) {
            removeEntry(entry, 'invalidate_worktree');
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
    subscribeMembership(listener) {
      if (disposed) return () => {};
      membershipListeners.add(listener);
      return () => membershipListeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      retentionCancel?.();
      retentionCancel = null;
      retentionGeneration += 1;
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
        membershipListeners.clear();
      });
    },
  };
}

function buildSnapshot<Resource extends TerminalPresentationResource>(
  entries: ReadonlyMap<string, EntryState<Resource>>,
): TerminalCacheSnapshot {
  const snapshots = [...entries.values()]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map<TerminalEntrySnapshot>((entry) =>
      Object.freeze({
        key: entry.key,
        identity: entry.identity,
        worktreeId: entry.worktreeId,
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

function defaultTimerScheduler(delayMs: number, callback: () => void): () => void {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
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
