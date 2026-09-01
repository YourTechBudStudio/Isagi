import assert from 'node:assert/strict';
import test from 'node:test';

import type { PtyProcessRow } from '../../pty-processes/index.js';
import { deriveEditorContextFacts } from '../projection.js';
import type {
  EditorAttemptRecord,
  EditorContextRow,
  EditorReadinessObservation,
} from '../types.js';

const NOW = '2026-08-31T00:00:00.000Z';

function ptyRow(overrides: Partial<PtyProcessRow> = {}): PtyProcessRow {
  return {
    id: 42,
    backend: 'node_pty',
    backendRefJson: '{"schemaVersion":1,"backend":"node_pty"}',
    command: 'code-server',
    args: [],
    argsJson: '[]',
    cwd: '/repo/isagi',
    status: 'running',
    statusReason: null,
    exitCode: null,
    signal: null,
    logMode: 'backend_file',
    logPath: '/data/sessions/42.ptylog',
    createdAt: NOW,
    updatedAt: NOW,
    exitedAt: null,
    lastSeenAt: NOW,
    ...overrides,
  };
}

function contextRow(overrides: Partial<EditorContextRow> = {}): EditorContextRow {
  return {
    id: 7,
    worktreeId: 3,
    activePtyProcessId: null,
    endpointHost: null,
    endpointPort: null,
    sessionSocketPath: null,
    attempt: { state: 'none' },
    createdAt: NOW,
    updatedAt: NOW,
    activePtyProcess: null,
    ...overrides,
  };
}

function owned(process: PtyProcessRow, attempt: EditorAttemptRecord = { state: 'none' }) {
  return contextRow({
    activePtyProcessId: process.id,
    endpointHost: '127.0.0.1',
    endpointPort: 41_287,
    sessionSocketPath: '/data/editors/code-server/sock/7-a1b2c3.sock',
    attempt,
    activePtyProcess: process,
  });
}

function observation(
  overrides: Partial<EditorReadinessObservation> = {},
): EditorReadinessObservation {
  return {
    ptyProcessId: 42,
    state: 'ready',
    detail: null,
    observedAt: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// No pointer
// ---------------------------------------------------------------------------

test('no pointer projects no process facts at all', () => {
  const facts = deriveEditorContextFacts(contextRow(), undefined);

  assert.equal(facts.activePtyProcessId, null);
  // Null rather than `starting`: an idle context must not look like a launching
  // one.
  assert.equal(facts.processStatus, null);
  assert.equal(facts.processDiagnostic, null);
  assert.equal(facts.workbenchReadiness, null);
  assert.equal(facts.endpoint, null);
  assert.equal(facts.hasDiagnostics, false);
  assert.deepEqual(facts.attempt, { state: 'none' });
});

test('no pointer with an in-progress attempt reads as launching', () => {
  const facts = deriveEditorContextFacts(
    contextRow({ attempt: { state: 'in_progress', startedAt: NOW } }),
    undefined,
  );

  assert.deepEqual(facts.attempt, { state: 'in_progress', startedAt: NOW });
  assert.equal(facts.processStatus, null);
  assert.equal(facts.workbenchReadiness, null);
});

test('no pointer with a failed attempt carries the reason and no readiness', () => {
  const facts = deriveEditorContextFacts(
    contextRow({
      attempt: {
        state: 'failed',
        reason: 'port_allocation_failed',
        detail: 'no free port',
      },
    }),
    undefined,
  );

  assert.deepEqual(facts.attempt, {
    state: 'failed',
    reason: 'port_allocation_failed',
    detail: 'no free port',
  });
  assert.equal(facts.workbenchReadiness, null);
  assert.equal(facts.readinessDetail, null);
  assert.equal(facts.hasDiagnostics, false);
});

// ---------------------------------------------------------------------------
// The `ready` safety rule
// ---------------------------------------------------------------------------

test('a live process with a matching observation projects ready and its endpoint', () => {
  const facts = deriveEditorContextFacts(owned(ptyRow()), observation());

  assert.equal(facts.workbenchReadiness, 'ready');
  assert.deepEqual(facts.endpoint, {
    host: '127.0.0.1',
    port: 41_287,
    url: 'http://127.0.0.1:41287',
  });
});

test('a ready observation beside an exited process is NOT ready', () => {
  // The safety property, asserted without any event being delivered: the
  // observation is stale and the row is terminal, so the pane must never frame
  // the iframe from it.
  const facts = deriveEditorContextFacts(
    owned(ptyRow({ status: 'exited', exitCode: 1, exitedAt: NOW })),
    observation(),
  );

  assert.equal(facts.workbenchReadiness, null);
  assert.equal(facts.processStatus, 'exited');
  assert.equal(facts.processDiagnostic, 'exited');
  assert.equal(facts.processDiagnosticDetail, 'PTY process exited with code 1.');
});

test('an observation keyed to a different incarnation is unknown, not ready', () => {
  const facts = deriveEditorContextFacts(
    owned(ptyRow()),
    observation({ ptyProcessId: 41, state: 'ready', detail: 'stale' }),
  );

  assert.equal(facts.workbenchReadiness, 'unknown');
  assert.equal(facts.readinessDetail, null);
});

test('a live process with no observation is unknown', () => {
  const facts = deriveEditorContextFacts(owned(ptyRow()), undefined);

  assert.equal(facts.workbenchReadiness, 'unknown');
  assert.equal(facts.readinessDetail, null);
});

test('pending and unreachable observations pass through with their detail', () => {
  const pending = deriveEditorContextFacts(
    owned(ptyRow({ status: 'starting' })),
    observation({ state: 'pending', detail: null }),
  );
  assert.equal(pending.workbenchReadiness, 'pending');

  const unreachable = deriveEditorContextFacts(
    owned(ptyRow()),
    observation({
      state: 'unreachable',
      detail: '127.0.0.1:41287 · workbench · marker absent · gave up after 60s',
    }),
  );
  assert.equal(unreachable.workbenchReadiness, 'unreachable');
  assert.equal(
    unreachable.readinessDetail,
    '127.0.0.1:41287 · workbench · marker absent · gave up after 60s',
  );
});

// ---------------------------------------------------------------------------
// Pointer to a row that is gone
// ---------------------------------------------------------------------------

test('a pointer to a vanished process row projects process_missing', () => {
  const facts = deriveEditorContextFacts(
    contextRow({
      activePtyProcessId: 42,
      endpointHost: '127.0.0.1',
      endpointPort: 41_287,
      activePtyProcess: null,
    }),
    observation(),
  );

  assert.equal(facts.processStatus, 'failed');
  assert.equal(facts.processDiagnostic, 'process_missing');
  assert.equal(facts.workbenchReadiness, null);
  assert.equal(facts.hasDiagnostics, false);
  // The pointer and the endpoint are still the truth about what this context
  // owned, so they survive the missing row.
  assert.equal(facts.activePtyProcessId, 42);
  assert.equal(facts.endpoint?.url, 'http://127.0.0.1:41287');
});

// ---------------------------------------------------------------------------
// A failed attempt composes alongside, never instead of
// ---------------------------------------------------------------------------

test('a refused replacement reports both the live process and the failed attempt', () => {
  const facts = deriveEditorContextFacts(
    owned(ptyRow(), {
      state: 'failed',
      reason: 'previous_incarnation_not_stopped',
      detail: 'PTY kill error (ptyProcess=42)',
    }),
    observation(),
  );

  assert.equal(facts.processStatus, 'running');
  assert.equal(facts.workbenchReadiness, 'ready');
  assert.deepEqual(facts.attempt, {
    state: 'failed',
    reason: 'previous_incarnation_not_stopped',
    detail: 'PTY kill error (ptyProcess=42)',
  });
});

// ---------------------------------------------------------------------------
// Diagnostics availability and the status/reason table
// ---------------------------------------------------------------------------

test('hasDiagnostics is a pure read of the log fields', () => {
  assert.equal(deriveEditorContextFacts(owned(ptyRow()), undefined).hasDiagnostics, true);
  assert.equal(
    deriveEditorContextFacts(owned(ptyRow({ logMode: 'none', logPath: null })), undefined)
      .hasDiagnostics,
    false,
  );
  assert.equal(
    deriveEditorContextFacts(owned(ptyRow({ logPath: null })), undefined).hasDiagnostics,
    false,
  );
});

test('every process status and failure reason maps to the editor vocabulary', () => {
  const cases: ReadonlyArray<
    readonly [PtyProcessRow['status'], PtyProcessRow['statusReason'], string | null]
  > = [
    ['starting', null, null],
    ['running', null, null],
    ['exited', null, 'exited'],
    ['killed', 'user_requested', 'killed'],
    ['failed', 'backend_launch_failed', 'launch_failed'],
    ['failed', 'backend_attach_failed', 'attach_failed'],
    ['failed', 'backend_process_missing', 'process_missing'],
    ['failed', 'runtime_ephemeral_lost', 'process_missing'],
  ];

  for (const [status, statusReason, expected] of cases) {
    const facts = deriveEditorContextFacts(owned(ptyRow({ status, statusReason })), undefined);
    assert.equal(facts.processDiagnostic, expected, `${status}/${statusReason}`);
    assert.equal(facts.processStatus, status);
  }
});
