import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { terminalSettingsDefaults, type TerminalCacheSettings } from '@isagi/contracts';

import {
  createTerminalPresentationCache,
  emptyTerminalBufferMeasurement,
  estimateTerminalPresentationBytes,
  terminalCellCostBytes,
  terminalEntryAllowanceBytes,
  terminalPlacementKey,
  terminalRetentionCandidates,
  terminalSessionKey,
  type TerminalAttachmentHandle,
  type TerminalBufferMeasurement,
  type TerminalCacheDiagnostic,
  type TerminalPlacement,
  type TerminalPresentationResource,
  type TerminalSessionHandle,
} from './index.js';

const identity = { kind: 'agent_session', sessionId: 7 } as const;
const placement = { worktreeId: 1, surfaceId: 2, paneId: 3 } as const;
const defaultTerminalCacheSettings = terminalSettingsDefaults.cache;

function cells(normalCells: number, alternateCells = 0): TerminalBufferMeasurement {
  return { normalCells, alternateCells };
}

function createHarness(
  settings: TerminalCacheSettings = defaultTerminalCacheSettings,
  estimateBytes?: (measurement: TerminalBufferMeasurement) => number,
  observe?: { readonly onDiagnostic: (diagnostic: TerminalCacheDiagnostic) => void },
) {
  let time = 1_000;
  let notifications = 0;
  const microtasks: Array<{ canceled: boolean; callback: () => void }> = [];
  const timers: Array<{ canceled: boolean; delayMs: number; callback: () => void }> = [];
  const diagnostics: TerminalCacheDiagnostic[] = [];
  const cache = createTerminalPresentationCache({
    settings,
    now: () => time,
    scheduleMicrotask: (callback) => {
      const task = { canceled: false, callback };
      microtasks.push(task);
      return () => {
        task.canceled = true;
      };
    },
    scheduleTimer: (delayMs, callback) => {
      const timer = { canceled: false, delayMs, callback };
      timers.push(timer);
      return () => {
        timer.canceled = true;
      };
    },
    estimateBytes,
    onDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic);
      observe?.onDiagnostic(diagnostic);
    },
  });
  cache.subscribe(() => {
    notifications += 1;
  });
  return {
    cache,
    diagnostics,
    get notifications() {
      return notifications;
    },
    entry() {
      return cache.getSnapshot().entries[0];
    },
    setTime(next: number) {
      time = next;
    },
    flushMicrotasks() {
      for (const task of microtasks.splice(0)) {
        if (!task.canceled) task.callback();
      }
    },
    runNextTimer() {
      const timer = timers.find((candidate) => !candidate.canceled);
      if (timer) {
        timer.canceled = true;
        timer.callback();
      }
      return timer?.delayMs ?? null;
    },
  };
}

function startAttachment<Resource extends TerminalPresentationResource>(
  session: TerminalSessionHandle<Resource>,
): TerminalAttachmentHandle<Resource> {
  const result = session.beginAttachment();
  assert.equal(result.status, 'started');
  if (result.status !== 'started') throw new Error('Expected attachment to start.');
  return result.attachment;
}

function disposable(onDispose?: () => void) {
  let calls = 0;
  const resource: TerminalPresentationResource = {
    dispose: () => {
      calls += 1;
      onDispose?.();
    },
  };
  return {
    resource,
    get calls() {
      return calls;
    },
  };
}

function acquire(session: TerminalSessionHandle, at: TerminalPlacement = placement) {
  const result = session.acquireVisibility(at);
  assert.equal(result.status, 'acquired');
  if (result.status !== 'acquired') throw new Error('Expected visibility acquisition.');
  return result.lease;
}

describe('terminal presentation cache identity and snapshots', () => {
  it('separates durable session kinds and uses a deterministic serialized key', () => {
    const harness = createHarness();
    harness.cache.ensureSession(identity, placement);
    harness.cache.ensureSession(
      { kind: 'terminal_session', sessionId: 7 },
      {
        ...placement,
        paneId: 4,
      },
    );

    assert.equal(terminalSessionKey(identity), 'agent_session:7');
    assert.deepEqual(
      harness.cache.getSnapshot().entries.map((entry) => entry.key),
      ['agent_session:7', 'terminal_session:7'],
    );
  });

  it('separates placements by worktree so the same pane identity cannot collide', () => {
    const other = { ...placement, worktreeId: 2 } as const;

    assert.equal(terminalPlacementKey(placement), '1:2:3');
    assert.notEqual(terminalPlacementKey(placement), terminalPlacementKey(other));

    const harness = createHarness();
    const session = harness.cache.ensureSession(identity, placement);
    assert.equal(session.acquireVisibility(other).status, 'placement_mismatch');
  });

  it('indexes the current placement so a slot can find the session it must render', () => {
    const harness = createHarness();
    const session = harness.cache.ensureSession(identity, placement);
    const moved = { worktreeId: 1, surfaceId: 8, paneId: 9 } as const;

    assert.equal(harness.cache.getSessionAtPlacement(placement)?.identity.sessionId, 7);
    assert.equal(harness.cache.getSessionAtPlacement(moved), null);

    session.movePlacement(moved);
    assert.equal(harness.cache.getSessionAtPlacement(placement), null);
    assert.equal(harness.cache.getSessionAtPlacement(moved)?.identity.sessionId, 7);

    session.invalidate();
    assert.equal(harness.cache.getSessionAtPlacement(moved), null);
  });

  it('gives a pane slot to its newest claimant and unplaces the displaced session', () => {
    const harness = createHarness();
    const displaced = harness.cache.ensureSession(identity, placement);
    const lease = acquire(displaced);

    const claimant = harness.cache.ensureSession(
      { kind: 'terminal_session', sessionId: 5 },
      placement,
    );

    assert.equal(harness.cache.getSessionAtPlacement(placement)?.identity.sessionId, 5);
    assert.equal(harness.entry()?.placement, null);
    assert.equal(displaced.acquireVisibility(placement).status, 'placement_mismatch');
    assert.equal(acquire(claimant) !== null, true);
    assert.deepEqual(
      harness.diagnostics.filter((diagnostic) => diagnostic.kind === 'placement_displaced'),
      [
        {
          kind: 'placement_displaced',
          operation: 'ensure_session',
          identityKey: 'agent_session:7',
          placement,
        },
      ],
    );

    // The displaced session hands its published presence off instead of flickering hidden.
    assert.equal(harness.entry()?.visible, true);
    lease.release();
    harness.flushMicrotasks();
    assert.equal(harness.entry()?.visible, false);
    assert.equal(harness.entry()?.placement, null);
  });

  it('unplaces the previous holder when a session moves into an occupied slot', () => {
    const harness = createHarness();
    const holder = harness.cache.ensureSession(identity, placement);
    const otherPlacement = { worktreeId: 1, surfaceId: 4, paneId: 4 } as const;
    const mover = harness.cache.ensureSession(
      { kind: 'terminal_session', sessionId: 5 },
      otherPlacement,
    );

    assert.equal(mover.movePlacement(placement), 'applied');
    assert.equal(harness.cache.getSessionAtPlacement(placement)?.identity.sessionId, 5);
    assert.equal(harness.cache.getSessionAtPlacement(otherPlacement), null);
    assert.equal(holder.acquireVisibility(placement).status, 'placement_mismatch');
    assert.equal(
      harness.cache.getSnapshot().entries.find((entry) => entry.key === 'agent_session:7')
        ?.placement,
      null,
    );
    // An unplaced session recovers by being explicitly placed again.
    assert.equal(holder.movePlacement(otherPlacement), 'applied');
    assert.equal(harness.cache.getSessionAtPlacement(otherPlacement)?.identity.sessionId, 7);
  });

  it('retains immutable durable scope across unplacement and rejects cross-worktree reuse', () => {
    const harness = createHarness();
    const session = harness.cache.ensureSession(identity, placement);
    assert.equal(session.unplace(), 'applied');
    assert.equal(harness.entry()?.placement, null);
    assert.equal(harness.entry()?.worktreeId, 1);
    assert.equal(session.movePlacement({ ...placement, worktreeId: 2 }), 'placement_mismatch');
    const mismatch = harness.cache.ensureSession(identity, { ...placement, worktreeId: 2 });
    assert.equal(mismatch.status, 'scope_mismatch');
    assert.equal(harness.cache.getSnapshot().entries.length, 1);
  });

  it('conditionally invalidates only the captured opaque incarnation', () => {
    const harness = createHarness();
    const first = harness.cache.ensureSession(identity, placement);
    const captured = harness.cache.captureIncarnations()[0];
    first.invalidate();
    harness.cache.ensureSession(identity, placement);
    assert.equal(captured?.invalidateIfCurrent(), 'stale');
    assert.equal(harness.cache.getSnapshot().entries.length, 1);
  });

  it('keeps immutable snapshot identity stable across reads and rejected operations', () => {
    const harness = createHarness();
    const session = harness.cache.ensureSession(identity, placement);
    const before = harness.cache.getSnapshot();
    const notifications = harness.notifications;

    assert.equal(
      session.acquireVisibility({ ...placement, paneId: 999 }).status,
      'placement_mismatch',
    );
    assert.strictEqual(harness.cache.getSnapshot(), before);
    assert.equal(harness.notifications, notifications);
    assert.deepEqual(harness.diagnostics, [
      {
        kind: 'operation_rejected',
        operation: 'acquire_visibility',
        identityKey: 'agent_session:7',
        result: 'placement_mismatch',
      },
    ]);
    assert.equal(Object.isFrozen(before), true);
    assert.equal(Object.isFrozen(before.entries), true);
    assert.equal(Object.isFrozen(before.entries[0]), true);
  });

  it('does not expose resources or mutation capabilities in snapshots', () => {
    const harness = createHarness();
    const session = harness.cache.ensureSession(identity, placement);
    const attachment = startAttachment(session);
    attachment.installResource(disposable().resource, cells(10));

    const serialized = JSON.stringify(harness.cache.getSnapshot());
    assert.doesNotMatch(serialized, /dispose|installResource|beginAttachment|token/);
  });
});

describe('terminal presentation cache diagnostics boundary', () => {
  it('keeps one owner per pane slot when a displacement diagnostic re-enters the cache', () => {
    let reenter: (() => void) | null = null;
    const harness = createHarness(defaultTerminalCacheSettings, undefined, {
      onDiagnostic: (diagnostic) => {
        if (diagnostic.kind !== 'placement_displaced') return;
        const run = reenter;
        reenter = null;
        run?.();
      },
    });
    const first = harness.cache.ensureSession(identity, placement);
    reenter = () => {
      harness.cache.ensureSession({ kind: 'terminal_session', sessionId: 9 }, placement);
    };

    harness.cache.ensureSession({ kind: 'terminal_session', sessionId: 5 }, placement);

    const placed = harness.cache
      .getSnapshot()
      .entries.filter((entry) => entry.placement !== null)
      .map((entry) => entry.key);
    assert.deepEqual(placed, ['terminal_session:9']);
    assert.equal(harness.cache.getSessionAtPlacement(placement)?.identity.sessionId, 9);
    assert.equal(first.acquireVisibility(placement).status, 'placement_mismatch');
  });

  it('contains a throwing diagnostic sink instead of interrupting the mutation', () => {
    const harness = createHarness(defaultTerminalCacheSettings, undefined, {
      onDiagnostic: () => {
        throw new Error('sink exploded');
      },
    });
    const session = harness.cache.ensureSession(identity, placement);
    const first = startAttachment(session);
    first.installResource(
      disposable(() => {
        throw new Error('renderer teardown failed');
      }).resource,
      cells(4),
    );
    first.markReady();

    const second = startAttachment(session);

    assert.equal(second.epoch, 2);
    assert.deepEqual(
      {
        lifecycle: harness.entry()?.lifecycle,
        epoch: harness.entry()?.attachmentEpoch,
        estimatedBytes: harness.entry()?.estimatedBytes,
      },
      { lifecycle: 'preparing', epoch: 2, estimatedBytes: 0 },
    );
    assert.equal(
      harness.diagnostics.filter((diagnostic) => diagnostic.kind === 'resource_dispose_failed')
        .length,
      1,
    );
    assert.equal(second.installResource(disposable().resource, cells(1)), 'applied');
  });
});

describe('terminal presentation accounting', () => {
  it('estimates a fixed per-entry allowance plus a per-cell cost across both buffers', () => {
    assert.equal(
      estimateTerminalPresentationBytes(emptyTerminalBufferMeasurement),
      terminalEntryAllowanceBytes,
    );
    assert.equal(
      estimateTerminalPresentationBytes(cells(1_000, 500)),
      terminalEntryAllowanceBytes + terminalCellCostBytes * 1_500,
    );
    assert.throws(() => estimateTerminalPresentationBytes(cells(-1)), RangeError);
  });

  it('routes attachment accounting through the injected estimator', () => {
    const measurements: TerminalBufferMeasurement[] = [];
    const harness = createHarness(defaultTerminalCacheSettings, (measurement) => {
      measurements.push(measurement);
      return measurement.normalCells;
    });
    const session = harness.cache.ensureSession(identity, placement);
    const attachment = startAttachment(session);

    assert.equal(attachment.installResource(disposable().resource, cells(64)), 'applied');
    assert.equal(harness.entry()?.estimatedBytes, 64);
    assert.equal(attachment.updateMeasurement(cells(128)), 'applied');
    assert.equal(harness.entry()?.estimatedBytes, 128);
    assert.deepEqual(measurements, [cells(64), cells(128)]);
    assert.equal(harness.cache.getSnapshot().totalEstimatedBytes, 128);
  });

  it('rejects an invalid estimate before taking ownership of the resource', () => {
    const harness = createHarness(defaultTerminalCacheSettings, () => -1);
    const session = harness.cache.ensureSession(identity, placement);
    const attachment = startAttachment(session);
    const installed = disposable();

    assert.throws(() => attachment.installResource(installed.resource, cells(1)), RangeError);
    assert.equal(harness.entry()?.lifecycle, 'preparing');
    assert.equal(harness.entry()?.estimatedBytes, 0);
    assert.equal(installed.calls, 0);
    assert.equal(attachment.isCurrentMutable(), true);
  });
});

describe('terminal presentation attachment lifecycle', () => {
  it('returns the one installed typed resource through visibility acquisition without exposing it in snapshots', () => {
    interface NamedResource extends TerminalPresentationResource {
      readonly name: string;
    }
    const cache = createTerminalPresentationCache<NamedResource>({
      settings: defaultTerminalCacheSettings,
    });
    const session = cache.ensureSession(identity, placement);
    const attachment = startAttachment(session);
    const resource: NamedResource = { name: 'stable-host-controller', dispose() {} };
    assert.equal(attachment.installResource(resource, emptyTerminalBufferMeasurement), 'applied');
    assert.equal(attachment.markReady(), 'applied');

    const acquisition = session.acquireVisibility(placement);
    assert.equal(acquisition.status, 'acquired');
    if (acquisition.status !== 'acquired') throw new Error('Expected acquisition.');
    assert.equal(acquisition.resource, resource);
    assert.equal('resource' in harnessSnapshot(cache), false);
    acquisition.lease.release();
    cache.dispose();
  });

  it('keeps the first seal reason when later transport outcomes race with process exit', () => {
    const harness = createHarness();
    const session = harness.cache.ensureSession(identity, placement);
    const attachment = startAttachment(session);
    attachment.installResource(disposable().resource, emptyTerminalBufferMeasurement);
    attachment.markReady();

    assert.equal(attachment.seal('exited'), 'applied');
    assert.equal(attachment.seal('disconnected'), 'sealed');
    assert.equal(harness.entry()?.sealReason, 'exited');
  });

  it('moves from cold through preparing and hot, then keeps a sealed resource displayable', () => {
    const harness = createHarness();
    const session = harness.cache.ensureSession(identity, placement);
    const attachment = startAttachment(session);
    const installed = disposable();

    assert.equal(attachment.installResource(installed.resource, cells(4)), 'applied');
    assert.equal(attachment.markReady(), 'applied');
    assert.equal(attachment.seal('disconnected'), 'applied');
    assert.deepEqual(
      harness.cache.getSnapshot().entries.map(({ lifecycle, sealReason, estimatedBytes }) => ({
        lifecycle,
        sealReason,
        estimatedBytes,
      })),
      [
        {
          lifecycle: 'sealed',
          sealReason: 'disconnected',
          estimatedBytes: terminalEntryAllowanceBytes + terminalCellCostBytes * 4,
        },
      ],
    );
    assert.equal(installed.calls, 0);
    assert.equal(attachment.markReady(), 'sealed');
  });

  it('abandons preparation, disposes once, preserves viewport, and invalidates the capability', () => {
    const harness = createHarness();
    const session = harness.cache.ensureSession(identity, placement);
    session.updateViewport({
      buffer: 'normal',
      followLatest: false,
      viewportY: 20,
      baseY: 50,
      columns: 100,
      rows: [{ text: 'anchor', wrapped: false }],
    });
    const attachment = startAttachment(session);
    const installed = disposable();
    attachment.installResource(installed.resource, cells(2));

    assert.equal(attachment.abortPreparation(), 'applied');
    assert.equal(attachment.abortPreparation(), 'stale');
    assert.equal(installed.calls, 1);
    assert.equal(harness.entry()?.lifecycle, 'cold');
    assert.equal(harness.entry()?.estimatedBytes, 0);
    assert.equal(harness.entry()?.viewport?.buffer, 'normal');
  });

  it('supersedes an old epoch without allowing its callbacks to mutate the replacement', () => {
    const harness = createHarness();
    const session = harness.cache.ensureSession(identity, placement);
    const first = startAttachment(session);
    const firstResource = disposable();
    first.installResource(firstResource.resource, cells(1));
    const second = startAttachment(session);

    assert.equal(firstResource.calls, 1);
    assert.equal(first.markReady(), 'stale');
    assert.equal(second.epoch, first.epoch + 1);
    assert.equal(harness.entry()?.lifecycle, 'preparing');
  });

  it('prevents epoch ABA after invalidation and recreation of the same durable identity', () => {
    const harness = createHarness();
    const oldSession = harness.cache.ensureSession(identity, placement);
    const oldAttachment = startAttachment(oldSession);
    assert.equal(oldSession.invalidate(), 'applied');

    const newSession = harness.cache.ensureSession(identity, placement);
    const newAttachment = startAttachment(newSession);
    assert.equal(oldAttachment.epoch, newAttachment.epoch);
    assert.equal(oldAttachment.installResource(disposable().resource, cells(1)), 'stale');
    assert.equal(oldSession.movePlacement({ worktreeId: 1, surfaceId: 8, paneId: 9 }), 'stale');
    assert.equal(harness.entry()?.lifecycle, 'preparing');
  });

  it('evicts only hidden presentations, preserving viewport memory', () => {
    const harness = createHarness();
    const session = harness.cache.ensureSession(identity, placement);
    session.updateViewport({ buffer: 'alternate', followLatest: true, columns: 80 });
    const attachment = startAttachment(session);
    const installed = disposable();
    attachment.installResource(installed.resource, cells(3));
    attachment.markReady();
    const lease = acquire(session);

    assert.equal(session.evictPresentation(), 'invalid_state');
    lease.release();
    // The pending-hidden handoff still holds visible presence, so eviction stays rejected.
    assert.equal(session.evictPresentation(), 'invalid_state');
    harness.flushMicrotasks();
    assert.equal(session.evictPresentation(), 'applied');
    assert.equal(installed.calls, 1);
    assert.deepEqual(harness.entry()?.viewport, {
      buffer: 'alternate',
      followLatest: true,
      columns: 80,
    });
  });
});

function harnessSnapshot<Resource extends TerminalPresentationResource>(
  cache: ReturnType<typeof createTerminalPresentationCache<Resource>>,
) {
  return cache.getSnapshot().entries[0] ?? {};
}

describe('terminal presentation resource disposal failures', () => {
  it('completes a lifecycle transition and reports a throwing disposal as a diagnostic', () => {
    const harness = createHarness();
    const session = harness.cache.ensureSession(identity, placement);
    const first = startAttachment(session);
    const failure = new Error('renderer teardown failed');
    first.installResource(
      disposable(() => {
        throw failure;
      }).resource,
      cells(5),
    );

    const second = startAttachment(session);
    assert.equal(second.epoch, first.epoch + 1);
    assert.equal(harness.entry()?.lifecycle, 'preparing');
    assert.equal(harness.entry()?.estimatedBytes, 0);
    assert.equal(first.isCurrentMutable(), false);
    assert.deepEqual(
      harness.diagnostics.filter((diagnostic) => diagnostic.kind === 'resource_dispose_failed'),
      [
        {
          kind: 'resource_dispose_failed',
          operation: 'begin_attachment',
          identityKey: 'agent_session:7',
          reason: 'resource_dispose_threw',
        },
      ],
    );
    // The replacement attachment owns a clean slot.
    assert.equal(second.installResource(disposable().resource, cells(1)), 'applied');
  });

  it('rejects a re-entrant disposer so no resource can attach to a superseded epoch', () => {
    const harness = createHarness();
    const session = harness.cache.ensureSession(identity, placement);
    const first = startAttachment(session);
    const nested = disposable();
    const nestedResults: string[] = [];
    first.installResource(
      disposable(() => {
        const attempt = session.beginAttachment();
        nestedResults.push(attempt.status);
        if (attempt.status === 'started') {
          nestedResults.push(attempt.attachment.installResource(nested.resource, cells(1)));
        }
        nestedResults.push(first.installResource(nested.resource, cells(1)));
        nestedResults.push(session.invalidate());
      }).resource,
      cells(5),
    );

    const second = startAttachment(session);

    assert.deepEqual(nestedResults, ['stale', 'stale', 'stale']);
    assert.equal(nested.calls, 0);
    assert.equal(second.epoch, first.epoch + 1);
    assert.equal(harness.entry()?.attachmentEpoch, second.epoch);
    assert.equal(harness.entry()?.estimatedBytes, 0);
    // The slot is free, so the surviving epoch owns the only resource.
    const replacement = disposable();
    assert.equal(second.installResource(replacement.resource, cells(1)), 'applied');
    assert.equal(harness.entry()?.lifecycle, 'preparing');
  });

  it('publishes one atomic snapshot when a disposer transitions another entry', () => {
    const harness = createHarness();
    const otherPlacement = { worktreeId: 1, surfaceId: 4, paneId: 4 } as const;
    const other = harness.cache.ensureSession(
      { kind: 'terminal_session', sessionId: 5 },
      otherPlacement,
    );
    startAttachment(other).installResource(disposable().resource, cells(2));

    const session = harness.cache.ensureSession(identity, placement);
    const first = startAttachment(session);
    first.installResource(
      disposable(() => {
        // Entry A's disposer transitions entry B, whose own disposal must not reopen publication.
        startAttachment(other);
      }).resource,
      cells(3),
    );
    first.markReady();

    const published: Array<Array<{ key: string; lifecycle: string; epoch: number }>> = [];
    harness.cache.subscribe(() => {
      published.push(
        harness.cache.getSnapshot().entries.map((entry) => ({
          key: entry.key,
          lifecycle: entry.lifecycle,
          epoch: entry.attachmentEpoch,
        })),
      );
    });

    const second = startAttachment(session);

    assert.equal(second.epoch, 2);
    assert.deepEqual(published, [
      [
        { key: 'agent_session:7', lifecycle: 'preparing', epoch: 2 },
        { key: 'terminal_session:5', lifecycle: 'preparing', epoch: 2 },
      ],
    ]);
  });

  it('accounts a visibility lease released from inside disposal exactly once', () => {
    const harness = createHarness();
    const session = harness.cache.ensureSession(identity, placement);
    const attachment = startAttachment(session);
    const lease = acquire(session);
    attachment.installResource(
      disposable(() => {
        lease.release();
        lease.release();
      }).resource,
      cells(1),
    );
    attachment.markReady();

    harness.setTime(6_000);
    const replacement = startAttachment(session);
    // Presence is held by the handoff, not by a ghost lease, so the transition publishes no churn.
    assert.equal(harness.entry()?.visible, true);

    harness.flushMicrotasks();
    assert.deepEqual(
      {
        visible: harness.entry()?.visible,
        count: harness.entry()?.visibilityLeaseCount,
        hiddenSince: harness.entry()?.hiddenSince,
      },
      { visible: false, count: 0, hiddenSince: 6_000 },
    );
    assert.equal(replacement.abortPreparation(), 'applied');
    assert.equal(session.evictPresentation(), 'applied');
  });

  it('rejects a re-entrant disposer during eviction and durable invalidation', () => {
    for (const teardown of ['evict', 'invalidate'] as const) {
      const harness = createHarness();
      const session = harness.cache.ensureSession(identity, placement);
      const attachment = startAttachment(session);
      const nestedResults: string[] = [];
      attachment.installResource(
        disposable(() => {
          nestedResults.push(attachment.seal('errored'));
          nestedResults.push(session.beginAttachment().status);
          nestedResults.push(
            session.updateViewport({
              buffer: 'alternate',
              followLatest: true,
              columns: 80,
            }),
          );
        }).resource,
        cells(1),
      );
      attachment.markReady();

      assert.equal(
        teardown === 'evict' ? session.evictPresentation() : session.invalidate(),
        'applied',
      );
      assert.deepEqual(nestedResults, ['stale', 'stale', 'stale']);
      assert.equal(
        harness.entry()?.lifecycle ?? 'removed',
        teardown === 'evict' ? 'cold' : 'removed',
      );
      assert.equal(harness.entry()?.sealReason ?? null, null);
    }
  });

  it('cleans up every entry and listener when one resource throws during cache disposal', () => {
    const harness = createHarness();
    const survivor = disposable();
    for (const [sessionId, resource] of [
      [
        1,
        disposable(() => {
          throw new Error('first');
        }).resource,
      ],
      [2, survivor.resource],
    ] as const) {
      const session = harness.cache.ensureSession(
        { kind: 'terminal_session', sessionId },
        { worktreeId: 1, surfaceId: 1, paneId: sessionId },
      );
      startAttachment(session).installResource(resource, cells(1));
    }

    harness.cache.dispose();
    assert.equal(survivor.calls, 1);
    assert.deepEqual(harness.cache.getSnapshot().entries, []);
    assert.equal(
      harness.cache.getSessionAtPlacement({ worktreeId: 1, surfaceId: 1, paneId: 2 }),
      null,
    );
    assert.deepEqual(
      harness.diagnostics.map((diagnostic) => diagnostic.kind),
      ['resource_dispose_failed'],
    );
  });
});

describe('terminal presentation visibility and placement', () => {
  it('cancels a StrictMode-style final-release handoff without publishing hidden state', () => {
    const harness = createHarness();
    const session = harness.cache.ensureSession(identity, placement);
    const first = acquire(session);
    const visibleSnapshot = harness.cache.getSnapshot();
    const notifications = harness.notifications;
    first.release();
    const second = acquire(session);
    harness.flushMicrotasks();

    assert.strictEqual(harness.cache.getSnapshot(), visibleSnapshot);
    assert.equal(harness.notifications, notifications);
    assert.equal(harness.entry()?.visible, true);
    second.release();
  });

  it('publishes overlapping lease ownership truthfully', () => {
    const harness = createHarness();
    const session = harness.cache.ensureSession(identity, placement);
    const first = acquire(session);
    assert.deepEqual(
      { visible: harness.entry()?.visible, count: harness.entry()?.visibilityLeaseCount },
      { visible: true, count: 1 },
    );

    const second = acquire(session);
    assert.deepEqual(
      { visible: harness.entry()?.visible, count: harness.entry()?.visibilityLeaseCount },
      { visible: true, count: 2 },
    );

    second.release();
    assert.deepEqual(
      { visible: harness.entry()?.visible, count: harness.entry()?.visibilityLeaseCount },
      { visible: true, count: 1 },
    );

    first.release();
    harness.flushMicrotasks();
    assert.deepEqual(
      { visible: harness.entry()?.visible, count: harness.entry()?.visibilityLeaseCount },
      { visible: false, count: 0 },
    );
  });

  it('commits hidden state using the original final-release time', () => {
    const harness = createHarness();
    const session = harness.cache.ensureSession(identity, placement);
    const first = acquire(session);
    const second = acquire(session);
    harness.setTime(4_000);
    first.release();
    assert.equal(harness.entry()?.visible, true);
    second.release();
    harness.setTime(9_000);
    harness.flushMicrotasks();

    assert.equal(harness.entry()?.hiddenSince, 4_000);
    assert.equal(harness.entry()?.lastHiddenAt, 4_000);
  });

  it('requires explicit movement and makes old-placement leases non-owning', () => {
    const harness = createHarness();
    const session = harness.cache.ensureSession(identity, placement);
    const oldLease = acquire(session);
    const nextPlacement = { worktreeId: 1, surfaceId: 8, paneId: 9 } as const;

    assert.equal(session.acquireVisibility(nextPlacement).status, 'placement_mismatch');
    assert.equal(session.movePlacement(nextPlacement), 'applied');
    const nextLease = acquire(session, nextPlacement);
    oldLease.release();
    harness.flushMicrotasks();
    assert.equal(harness.entry()?.visible, true);
    assert.deepEqual(harness.entry()?.placement, nextPlacement);
    nextLease.release();
  });

  it('relocates a visible session without ever publishing a hidden presence', () => {
    const harness = createHarness();
    const session = harness.cache.ensureSession(identity, placement);
    const oldLease = acquire(session);
    const nextPlacement = { worktreeId: 1, surfaceId: 8, paneId: 9 } as const;
    const published: Array<{ visible: boolean; placement: TerminalPlacement | null }> = [];
    harness.cache.subscribe(() => {
      const entry = harness.entry();
      if (entry) published.push({ visible: entry.visible, placement: entry.placement });
    });

    assert.equal(session.movePlacement(nextPlacement), 'applied');
    const nextLease = acquire(session, nextPlacement);
    oldLease.release();
    harness.flushMicrotasks();

    assert.deepEqual(published, [{ visible: true, placement: nextPlacement }]);
    assert.equal(harness.entry()?.visible, true);
    assert.equal(harness.entry()?.hiddenSince, null);
    nextLease.release();
    harness.flushMicrotasks();
    assert.equal(harness.entry()?.visible, false);
  });

  it('hides a relocated session when no slot reacquires at the new placement', () => {
    const harness = createHarness();
    const session = harness.cache.ensureSession(identity, placement);
    acquire(session);
    harness.setTime(5_000);

    assert.equal(session.movePlacement({ worktreeId: 1, surfaceId: 8, paneId: 9 }), 'applied');
    assert.equal(harness.entry()?.visible, true);
    harness.flushMicrotasks();
    assert.deepEqual(
      {
        visible: harness.entry()?.visible,
        count: harness.entry()?.visibilityLeaseCount,
        hiddenSince: harness.entry()?.hiddenSince,
      },
      { visible: false, count: 0, hiddenSince: 5_000 },
    );
  });
});

describe('terminal retention evaluation and disposal', () => {
  it('enforces zero hidden retention only after the pending-hidden handoff', () => {
    const harness = createHarness({
      idleTtlMinutes: 0,
      maxHiddenSessions: 0,
      maxEstimatedBufferMiB: 0,
    });
    const session = harness.cache.ensureSession(identity, placement);
    const attachment = startAttachment(session);
    const resource = disposable();
    attachment.installResource(resource.resource, cells(1));
    attachment.markReady();
    const lease = acquire(session);
    harness.flushMicrotasks();
    assert.equal(resource.calls, 0);
    lease.release();
    assert.equal(resource.calls, 0);
    harness.flushMicrotasks();
    harness.flushMicrotasks();
    assert.equal(resource.calls, 1);
    assert.equal(harness.entry()?.lifecycle, 'cold');
  });

  it('never evicts a sealed terminal a pane is still holding on screen', () => {
    // The harshest retention policy there is: zero hidden slots, zero budget, zero TTL.
    const harness = createHarness({
      idleTtlMinutes: 0,
      maxHiddenSessions: 0,
      maxEstimatedBufferMiB: 0,
    });
    const session = harness.cache.ensureSession(identity, placement);
    const attachment = startAttachment(session);
    const resource = disposable();
    attachment.installResource(resource.resource, cells(1));
    attachment.markReady();
    const lease = acquire(session);

    // The process exits. Transport intent is gone, but the pane keeps its lease because it
    // keeps rendering the sealed output as the session's final word.
    assert.equal(attachment.seal('exited'), 'applied');
    harness.flushMicrotasks();
    harness.flushMicrotasks();
    harness.setTime(1_000 + 10 * 60_000);
    harness.flushMicrotasks();

    assert.equal(resource.calls, 0, 'a visible sealed terminal is not an eviction candidate');
    assert.equal(harness.entry()?.lifecycle, 'sealed');
    assert.equal(harness.entry()?.visible, true);

    // Unmounting the pane is what makes it collectable.
    lease.release();
    harness.flushMicrotasks();
    harness.flushMicrotasks();
    assert.equal(resource.calls, 1);
    assert.equal(harness.entry()?.lifecycle, 'cold');
  });

  it('schedules the exact TTL and recomputes after suspension', () => {
    const harness = createHarness({
      ...defaultTerminalCacheSettings,
      idleTtlMinutes: 180,
    });
    const session = harness.cache.ensureSession(identity, placement);
    const attachment = startAttachment(session);
    const resource = disposable();
    attachment.installResource(resource.resource, cells(1));
    attachment.markReady();
    harness.flushMicrotasks();
    harness.setTime(1_000 + 180 * 60_000);
    assert.equal(harness.runNextTimer(), 180 * 60_000);
    assert.equal(resource.calls, 1);
  });
  it('calculates eligibility from snapshot, policy, and now with deterministic ties', () => {
    const harness = createHarness({
      ...defaultTerminalCacheSettings,
      idleTtlMinutes: 1,
      maxHiddenSessions: 1,
      maxEstimatedBufferMiB: 64,
    });
    for (const sessionId of [3, 1, 2]) {
      const session = harness.cache.ensureSession(
        { kind: 'terminal_session', sessionId },
        { worktreeId: 1, surfaceId: 1, paneId: sessionId },
      );
      const attachment = startAttachment(session);
      attachment.installResource(disposable().resource, cells(1));
      attachment.markReady();
    }
    const snapshot = harness.cache.getSnapshot();

    assert.deepEqual(
      terminalRetentionCandidates(snapshot, harness.cache.settings, 1_000).map(
        (entry) => entry.key,
      ),
      ['terminal_session:1', 'terminal_session:2'],
    );
    assert.deepEqual(
      terminalRetentionCandidates(snapshot, harness.cache.settings, 61_000).map(
        (entry) => entry.key,
      ),
      ['terminal_session:1', 'terminal_session:2', 'terminal_session:3'],
    );
    assert.strictEqual(harness.cache.getSnapshot(), snapshot);
  });

  it('excludes visible entries and treats zero retention as immediately evictable', () => {
    const harness = createHarness({
      ...defaultTerminalCacheSettings,
      idleTtlMinutes: 0,
      maxHiddenSessions: 0,
      maxEstimatedBufferMiB: 0,
    });
    const hidden = harness.cache.ensureSession(identity, placement);
    const hiddenAttachment = startAttachment(hidden);
    hiddenAttachment.installResource(disposable().resource, cells(1));
    hiddenAttachment.markReady();
    const visiblePlacement = { worktreeId: 1, surfaceId: 1, paneId: 9 } as const;
    const visible = harness.cache.ensureSession(
      { kind: 'terminal_session', sessionId: 9 },
      visiblePlacement,
    );
    const visibleAttachment = startAttachment(visible);
    visibleAttachment.installResource(disposable().resource, cells(1));
    visibleAttachment.markReady();
    acquire(visible, visiblePlacement);

    assert.deepEqual(
      terminalRetentionCandidates(harness.cache.getSnapshot(), harness.cache.settings, 1_000).map(
        (entry) => entry.key,
      ),
      ['agent_session:7'],
    );
  });

  it('invalidates sessions absent from a live identity sweep', () => {
    const harness = createHarness();
    const kept = harness.cache.ensureSession(identity, placement);
    const removedPlacement = { worktreeId: 1, surfaceId: 1, paneId: 4 } as const;
    const removed = harness.cache.ensureSession(
      { kind: 'terminal_session', sessionId: 4 },
      removedPlacement,
    );
    removed.updateViewport({ buffer: 'alternate', followLatest: true, columns: 80 });

    const captured = harness.cache.captureIncarnations();
    captured.find((entry) => entry.identity.kind === 'terminal_session')?.invalidateIfCurrent();
    assert.deepEqual(
      harness.cache.getSnapshot().entries.map((entry) => entry.key),
      [terminalSessionKey(identity)],
    );
    assert.equal(harness.cache.getSessionAtPlacement(removedPlacement), null);
    assert.equal(removed.invalidate(), 'stale');
    assert.equal(kept.invalidate(), 'applied');
  });

  it('disposes every resource at most once and makes whole-cache disposal idempotent', () => {
    const harness = createHarness();
    const session = harness.cache.ensureSession(identity, placement);
    const attachment = startAttachment(session);
    const installed = disposable();
    attachment.installResource(installed.resource, cells(1));

    harness.cache.dispose();
    harness.cache.dispose();
    session.invalidate();
    attachment.abortPreparation();
    assert.equal(installed.calls, 1);
    assert.deepEqual(harness.cache.getSnapshot().entries, []);
  });
});
