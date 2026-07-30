import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DESKTOP_UPDATE_PROTOCOL_VERSION, type DesktopUpdateSnapshot } from '@isagi/contracts';

import {
  desktopUpdateReducer,
  initialDesktopUpdateState,
  toDesktopUpdateState,
  toRestartActivity,
} from './useDesktopUpdate.js';

const base = {
  protocolVersion: DESKTOP_UPDATE_PROTOCOL_VERSION,
  revision: 7,
  installedVersion: '0.4.2',
} as const;

/** Every member of the contract union, so a new one cannot be added unmapped. */
const SNAPSHOTS = [
  { ...base, state: 'disabled' },
  { ...base, state: 'idle' },
  { ...base, state: 'checking' },
  { ...base, state: 'up_to_date' },
  { ...base, state: 'downloading', targetVersion: '0.4.3', progressPercent: 38 },
  { ...base, state: 'ready', targetVersion: '0.4.3' },
  {
    ...base,
    state: 'restart_confirmation',
    targetVersion: '0.4.3',
    activity: { kind: 'working', workingAgentCount: 2 },
  },
  { ...base, state: 'restart_confirmation', targetVersion: '0.4.3', activity: { kind: 'unknown' } },
  { ...base, state: 'installing', targetVersion: '0.4.3' },
  {
    ...base,
    state: 'manual_update_required',
    reason: 'unsupported_installation',
    openFailure: null,
  },
  {
    ...base,
    state: 'manual_update_required',
    reason: 'unsupported_installation',
    openFailure: 'download_page_open_failed',
  },
  { ...base, state: 'failed', operation: 'check', code: 'check_failed' },
  {
    ...base,
    state: 'failed',
    operation: 'download',
    code: 'download_failed',
    targetVersion: '0.4.3',
  },
] as const satisfies readonly DesktopUpdateSnapshot[];

describe('toDesktopUpdateState', () => {
  it('maps every contract state to a view state', () => {
    assert.deepEqual(
      SNAPSHOTS.map((snapshot) => toDesktopUpdateState(snapshot).kind),
      [
        'disabled',
        'idle',
        'checking',
        'up-to-date',
        'downloading',
        'ready',
        // A confirmation is the ready control with a question attached, not a
        // different place in the rail.
        'ready',
        'ready',
        'installing',
        // A launch that failed is the same state with a worse last attempt, not
        // a state of its own.
        'manual-required',
        'manual-required',
        'check-failed',
        'download-failed',
      ],
    );
  });

  it('carries the target version wherever the user is told about one', () => {
    assert.deepEqual(toDesktopUpdateState(SNAPSHOTS[4]), {
      kind: 'downloading',
      version: '0.4.3',
      percent: 38,
    });
    assert.deepEqual(toDesktopUpdateState(SNAPSHOTS[8]), {
      kind: 'installing',
      version: '0.4.3',
    });
    assert.deepEqual(toDesktopUpdateState(SNAPSHOTS[12]), {
      kind: 'download-failed',
      version: '0.4.3',
    });
  });

  it('rounds progress so the rail is not asked to render a fractional percent', () => {
    const state = toDesktopUpdateState({
      ...base,
      state: 'downloading',
      targetVersion: '0.4.3',
      progressPercent: 38.7,
    });

    assert.deepEqual(state, { kind: 'downloading', version: '0.4.3', percent: 39 });
  });

  it('never claims a version for a build that installs by hand', () => {
    // The state is decided during composition, before any provider is contacted.
    assert.deepEqual(toDesktopUpdateState(SNAPSHOTS[9]), {
      kind: 'manual-required',
      openFailed: false,
    });
  });

  it('surfaces a download page that never opened, so the press is not silent', () => {
    // The host cannot report this any other way: launching a browser produces no
    // updater event, and the intent resolves whether or not it worked.
    assert.deepEqual(toDesktopUpdateState(SNAPSHOTS[10]), {
      kind: 'manual-required',
      openFailed: true,
    });
  });
});

describe('desktopUpdateReducer', () => {
  const ready = { ...base, revision: 3, state: 'ready', targetVersion: '0.4.3' } as const;
  const apply = (...events: Parameters<typeof desktopUpdateReducer>[1][]) =>
    events.reduce(desktopUpdateReducer, initialDesktopUpdateState);

  it('keeps the greatest revision, so a late current-snapshot reply cannot rewind', () => {
    // Subscribe-then-reconcile races by design: the push may beat the reply.
    const state = apply(
      { kind: 'snapshot', snapshot: { ...ready, revision: 9, state: 'installing' } },
      { kind: 'snapshot', snapshot: ready },
    );

    assert.equal(state.snapshot?.revision, 9);
    assert.equal(state.snapshot?.state, 'installing');
  });

  it('holds the same object when a snapshot changes nothing, so the rail does not rerender', () => {
    const first = desktopUpdateReducer(initialDesktopUpdateState, {
      kind: 'snapshot',
      snapshot: ready,
    });

    assert.equal(desktopUpdateReducer(first, { kind: 'snapshot', snapshot: ready }), first);
  });

  it('clears the pending restart when the request settles', () => {
    const pending = apply({ kind: 'snapshot', snapshot: ready }, { kind: 'restart_requested' });
    assert.equal(pending.restartPending, true);

    // The desktop may decide the request was a no-op and publish nothing. The
    // settled promise is what has to release the control in that case.
    assert.equal(desktopUpdateReducer(pending, { kind: 'restart_settled' }).restartPending, false);
  });

  it('clears the pending restart whenever the host stops offering a plain restart', () => {
    for (const next of [
      { ...ready, revision: 4, state: 'installing' },
      {
        ...ready,
        revision: 4,
        state: 'restart_confirmation',
        activity: { kind: 'unknown' },
      },
      { ...base, revision: 4, state: 'idle' },
    ] as const satisfies readonly DesktopUpdateSnapshot[]) {
      const state = apply(
        { kind: 'snapshot', snapshot: ready },
        { kind: 'restart_requested' },
        { kind: 'snapshot', snapshot: next },
      );

      assert.equal(state.restartPending, false, `${next.state} left the control disabled`);
    }
  });

  it('stays pending while the host is still only offering a restart', () => {
    // A progress or unrelated republication of `ready` is not an answer.
    const state = apply(
      { kind: 'snapshot', snapshot: ready },
      { kind: 'restart_requested' },
      { kind: 'snapshot', snapshot: { ...ready, revision: 4 } },
    );

    assert.equal(state.restartPending, true);
  });
});

describe('toRestartActivity', () => {
  it('asks only when the host is asking', () => {
    for (const snapshot of SNAPSHOTS) {
      const expected = snapshot.state === 'restart_confirmation';
      assert.equal(
        toRestartActivity(snapshot) !== null,
        expected,
        `${snapshot.state} disagreed about confirmation`,
      );
    }
  });

  it('keeps unknown activity distinct from a count', () => {
    assert.deepEqual(toRestartActivity(SNAPSHOTS[6]), { kind: 'working', workingAgentCount: 2 });
    assert.deepEqual(toRestartActivity(SNAPSHOTS[7]), { kind: 'unknown' });
  });
});
