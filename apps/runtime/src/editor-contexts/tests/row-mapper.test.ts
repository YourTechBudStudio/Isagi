import assert from 'node:assert/strict';
import test from 'node:test';

import { type InferSelectModel } from 'drizzle-orm';

import { editorContexts, ptyProcesses } from '../../persistence/schema.js';
import { editorContextRow, EditorContextRowInvariantViolation } from '../row-mapper.js';

type EditorContextRecord = InferSelectModel<typeof editorContexts>;
type PtyProcessRecord = InferSelectModel<typeof ptyProcesses>;

const NOW = '2026-08-31T00:00:00.000Z';

function record(overrides: Partial<EditorContextRecord> = {}): EditorContextRecord {
  return {
    id: 7,
    worktreeId: 3,
    activePtyProcessId: null,
    endpointHost: null,
    endpointPort: null,
    sessionSocketPath: null,
    attemptState: 'none',
    attemptReason: null,
    attemptDetail: null,
    attemptStartedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const RUNNING: EditorContextRecord = record({
  activePtyProcessId: 42,
  endpointHost: '127.0.0.1',
  endpointPort: 41_234,
  sessionSocketPath: '/tmp/isagi/editors/code-server/sock/7-abc123.sock',
});

function ptyRecord(): PtyProcessRecord {
  return {
    id: 42,
    backend: 'node_pty',
    backendRefJson: '{}',
    command: 'code-server',
    argsJson: JSON.stringify(['--auth', 'none']),
    cwd: '/repo/isagi',
    status: 'running',
    statusReason: null,
    exitCode: null,
    signal: null,
    logMode: 'backend_file',
    logPath: '/tmp/editor.log',
    createdAt: NOW,
    updatedAt: NOW,
    exitedAt: null,
    lastSeenAt: null,
  };
}

/** Decodes and returns the invariant violation, failing if the row was accepted. */
function violation(input: EditorContextRecord): EditorContextRowInvariantViolation {
  try {
    editorContextRow(input, null);
  } catch (error) {
    assert.ok(
      error instanceof EditorContextRowInvariantViolation,
      `Expected an invariant violation, got ${String(error)}.`,
    );
    return error;
  }
  assert.fail('Expected the row to be rejected, but it decoded.');
}

test('an idle context decodes to attempt none with no pointer or endpoint', () => {
  const row = editorContextRow(record(), null);
  assert.deepEqual(row.attempt, { state: 'none' });
  assert.equal(row.activePtyProcessId, null);
  assert.equal(row.endpointHost, null);
  assert.equal(row.activePtyProcess, null);
});

test('an in-progress attempt decodes with its started-at and nothing else', () => {
  const row = editorContextRow(
    record({ attemptState: 'in_progress', attemptStartedAt: NOW }),
    null,
  );
  assert.deepEqual(row.attempt, { state: 'in_progress', startedAt: NOW });
});

test('a failed attempt decodes its reason and its nullable detail', () => {
  const withDetail = editorContextRow(
    record({
      attemptState: 'failed',
      attemptReason: 'port_allocation_failed',
      attemptDetail: 'no free port',
    }),
    null,
  );
  assert.deepEqual(withDetail.attempt, {
    state: 'failed',
    reason: 'port_allocation_failed',
    detail: 'no free port',
  });

  const withoutDetail = editorContextRow(
    record({ attemptState: 'failed', attemptReason: 'launch_interrupted' }),
    null,
  );
  assert.deepEqual(withoutDetail.attempt, {
    state: 'failed',
    reason: 'launch_interrupted',
    detail: null,
  });
});

test('a live context carries its pointer, endpoint, socket, and joined process', () => {
  const row = editorContextRow(RUNNING, ptyRecord());
  assert.equal(row.activePtyProcessId, 42);
  assert.equal(row.endpointHost, '127.0.0.1');
  assert.equal(row.endpointPort, 41_234);
  assert.equal(row.activePtyProcess?.status, 'running');
  assert.deepEqual(row.activePtyProcess?.args, ['--auth', 'none']);
});

test('a pointer whose process row is gone is valid, not malformed', () => {
  // The pointer is durable and the PTY row it names can be collected. Phase 06
  // decides what a vanished incarnation means; the decoder must not pre-empt it.
  const row = editorContextRow(RUNNING, null);
  assert.equal(row.activePtyProcessId, 42);
  assert.equal(row.activePtyProcess, null);
});

test('invariant 1: a pointer without a complete endpoint is a defect', () => {
  for (const partial of [
    { endpointHost: null },
    { endpointPort: null },
    { sessionSocketPath: null },
  ] as const) {
    const error = violation({ ...RUNNING, ...partial });
    assert.match(error.message, /Editor context 7 violates row invariant/);
    assert.match(error.message, /complete endpoint/);
  }
});

test('invariant 1: an endpoint or socket without a pointer is a defect', () => {
  for (const orphaned of [
    { endpointHost: '127.0.0.1' },
    { endpointPort: 41_234 },
    { sessionSocketPath: '/tmp/a.sock' },
  ]) {
    const error = violation(record(orphaned));
    assert.match(error.message, /without a pointer/);
  }
});

test('invariant 2: in_progress beside a pointer is a defect', () => {
  const error = violation({
    ...RUNNING,
    attemptState: 'in_progress',
    attemptStartedAt: NOW,
  });
  assert.match(error.message, /in_progress beside a pointer/);
});

test('invariant 3: failed without a reason is a defect', () => {
  const error = violation(record({ attemptState: 'failed' }));
  assert.match(error.message, /failed has no reason/);
});

test('invariant 4: a reason or detail outside a failed attempt is a defect', () => {
  assert.match(
    violation(record({ attemptReason: 'launch_interrupted' })).message,
    /none carries a reason or detail/,
  );
  assert.match(
    violation(record({ attemptDetail: 'stale' })).message,
    /none carries a reason or detail/,
  );
  assert.match(
    violation(
      record({ attemptState: 'in_progress', attemptStartedAt: NOW, attemptDetail: 'stale' }),
    ).message,
    /in_progress carries a reason or detail/,
  );
});

test('invariant 5: failed beside a pointer is legal only for a refused replacement', () => {
  const refused = editorContextRow(
    {
      ...RUNNING,
      attemptState: 'failed',
      attemptReason: 'previous_incarnation_not_stopped',
      attemptDetail: 'kill timed out',
    },
    ptyRecord(),
  );
  // The one case that reports a live incarnation and a failed attempt at once.
  assert.equal(refused.activePtyProcessId, 42);
  assert.deepEqual(refused.attempt, {
    state: 'failed',
    reason: 'previous_incarnation_not_stopped',
    detail: 'kill timed out',
  });

  const error = violation({
    ...RUNNING,
    attemptState: 'failed',
    attemptReason: 'port_allocation_failed',
    attemptDetail: null,
  });
  assert.match(error.message, /failed\{port_allocation_failed\} beside a retained pointer/);
});

test('the started-at column belongs to in_progress and to no other state', () => {
  assert.match(violation(record({ attemptStartedAt: NOW })).message, /none carries a started-at/);
  assert.match(
    violation(record({ attemptState: 'in_progress' })).message,
    /in_progress has no started-at/,
  );
  assert.match(
    violation(
      record({
        attemptState: 'failed',
        attemptReason: 'launch_interrupted',
        attemptStartedAt: NOW,
      }),
    ).message,
    /failed carries a started-at/,
  );
});

test('a defect message names the context and the rule, and nothing else', () => {
  const error = violation(
    record({ attemptDetail: 'a support ticket number and a filesystem path' }),
  );
  assert.equal(
    error.message,
    'Editor context 7 violates row invariant: attempt=none carries a reason or detail.',
  );
  assert.equal(error.editorContextId, 7);
});
