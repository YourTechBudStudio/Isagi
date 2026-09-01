import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { EditorContextFacts } from '@isagi/contracts';

import { editorAttemptBanner, editorPaneView, editorStartIntent } from './view.js';

const base: EditorContextFacts = {
  id: 7,
  worktreeId: 3,
  activePtyProcessId: null,
  attempt: { state: 'none' },
  processStatus: null,
  processDiagnostic: null,
  processDiagnosticDetail: null,
  workbenchReadiness: null,
  readinessDetail: null,
  endpoint: null,
  hasDiagnostics: false,
  createdAt: '2026-08-31T09:00:00.000Z',
  updatedAt: '2026-08-31T09:00:00.000Z',
};

const facts = (overrides: Partial<EditorContextFacts>): EditorContextFacts => ({
  ...base,
  ...overrides,
});

const live = {
  activePtyProcessId: 48120,
  processStatus: 'running',
  endpoint: { host: '127.0.0.1', port: 41287, url: 'http://127.0.0.1:41287' },
} as const;

describe('editorPaneView precedence', () => {
  it('rule 1 — a failed attempt that left nothing running owns the pane', () => {
    const view = editorPaneView(
      facts({
        attempt: { state: 'failed', reason: 'port_allocation_failed', detail: 'no free port' },
      }),
    );

    assert.deepEqual(view, {
      kind: 'settled',
      reason: { kind: 'attempt_failed', reason: 'port_allocation_failed' },
      detail: 'no free port',
    });
  });

  it('rule 1 does not fire while a pointer survives — the refused replacement', () => {
    // The whole point of the `processStatus === null` guard: a replacement that
    // was refused because the old process would not stop must report the live
    // incarnation, not swallow it behind the attempt failure.
    const context = facts({
      ...live,
      attempt: { state: 'failed', reason: 'previous_incarnation_not_stopped', detail: null },
      workbenchReadiness: 'ready',
    });

    assert.deepEqual(editorPaneView(context), { kind: 'ready', url: 'http://127.0.0.1:41287' });
    assert.deepEqual(editorAttemptBanner(context), {
      reason: 'previous_incarnation_not_stopped',
      detail: null,
    });
  });

  it('rule 2 — an attempt in flight outranks the outgoing incarnation', () => {
    const view = editorPaneView(
      facts({
        ...live,
        workbenchReadiness: 'ready',
        attempt: { state: 'in_progress', startedAt: '2026-08-31T09:12:00.000Z' },
      }),
    );

    assert.deepEqual(view, { kind: 'launching' });
  });

  it('rule 3 — no attempt and no pointer is idle', () => {
    assert.deepEqual(editorPaneView(base), { kind: 'idle' });
  });

  it('rule 4 — a terminal status reports the runtime diagnostic', () => {
    const view = editorPaneView(
      facts({
        activePtyProcessId: 48120,
        processStatus: 'failed',
        processDiagnostic: 'attach_failed',
        processDiagnosticDetail: 'spawn ENOENT',
      }),
    );

    assert.deepEqual(view, {
      kind: 'settled',
      reason: { kind: 'process', diagnostic: 'attach_failed' },
      detail: 'spawn ENOENT',
    });
  });

  it('rule 4 stays total when a terminal status arrives without a diagnostic', () => {
    for (const [status, diagnostic] of [
      ['exited', 'exited'],
      ['killed', 'killed'],
      ['failed', 'launch_failed'],
    ] as const) {
      const view = editorPaneView(facts({ activePtyProcessId: 1, processStatus: status }));
      assert.deepEqual(view, {
        kind: 'settled',
        reason: { kind: 'process', diagnostic },
        detail: null,
      });
    }
  });

  it('rule 5 — ready with an endpoint is the only state that frames a url', () => {
    const view = editorPaneView(facts({ ...live, workbenchReadiness: 'ready' }));
    assert.deepEqual(view, { kind: 'ready', url: 'http://127.0.0.1:41287' });
  });

  it('rule 6 — a running probe is a wait, not a failure', () => {
    const view = editorPaneView(
      facts({ activePtyProcessId: 48120, processStatus: 'running', workbenchReadiness: 'pending' }),
    );
    assert.deepEqual(view, { kind: 'waiting_for_workbench' });
  });

  it('rules 7 and 8 — unreachable and unknown settle with the readiness detail', () => {
    const unreachable = editorPaneView(
      facts({
        ...live,
        workbenchReadiness: 'unreachable',
        readinessDetail: 'ECONNREFUSED',
      }),
    );
    assert.deepEqual(unreachable, {
      kind: 'settled',
      reason: { kind: 'unreachable' },
      detail: 'ECONNREFUSED',
    });

    const unknown = editorPaneView(
      facts({ ...live, workbenchReadiness: 'unknown', readinessDetail: null }),
    );
    assert.deepEqual(unknown, { kind: 'settled', reason: { kind: 'unknown' }, detail: null });
  });

  it('rule 9 — starting with nothing observed is launching', () => {
    assert.deepEqual(
      editorPaneView(facts({ activePtyProcessId: 48120, processStatus: 'starting' })),
      { kind: 'launching' },
    );
  });

  it('rule 9 also catches a ready reading with no endpoint to frame', () => {
    assert.deepEqual(
      editorPaneView(
        facts({ activePtyProcessId: 1, processStatus: 'running', workbenchReadiness: 'ready' }),
      ),
      { kind: 'launching' },
    );
  });
});

describe('editorAttemptBanner', () => {
  it('is silent when the attempt failure is already the whole state', () => {
    assert.equal(
      editorAttemptBanner(
        facts({ attempt: { state: 'failed', reason: 'launch_interrupted', detail: null } }),
      ),
      null,
    );
  });

  it('is silent when no attempt has failed', () => {
    assert.equal(editorAttemptBanner(facts({ ...live, workbenchReadiness: 'ready' })), null);
    assert.equal(
      editorAttemptBanner(facts({ ...live, attempt: { state: 'in_progress', startedAt: 'now' } })),
      null,
    );
  });
});

describe('editorStartIntent', () => {
  it('offers reuse for the genuine first launch and replace for recovery', () => {
    assert.equal(editorStartIntent({ kind: 'idle' }), 'reuse');
    assert.equal(
      editorStartIntent({ kind: 'settled', reason: { kind: 'unknown' }, detail: null }),
      'replace',
    );
  });

  it('offers nothing while a launch or a probe is still running', () => {
    assert.equal(editorStartIntent({ kind: 'launching' }), null);
    assert.equal(editorStartIntent({ kind: 'waiting_for_workbench' }), null);
    assert.equal(editorStartIntent({ kind: 'ready', url: 'http://127.0.0.1:41287' }), null);
  });
});
