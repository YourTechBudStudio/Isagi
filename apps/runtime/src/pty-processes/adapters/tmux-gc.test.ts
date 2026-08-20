import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import type { PtyBackendGcSession, TmuxBackendRef } from '../types.js';
import { collectTmuxGarbage } from './tmux-gc.js';

const namespace = 'test-runtime';

function tmuxSession(ptyProcessId: number): TmuxBackendRef {
  return {
    schemaVersion: 1,
    backend: 'tmux',
    sessionName: `isagi_${namespace}_${ptyProcessId}`,
  };
}

function collect(input: {
  readonly live: readonly TmuxBackendRef[];
  readonly sessions: readonly PtyBackendGcSession[];
}) {
  return Effect.runPromise(
    collectTmuxGarbage(
      { runtimeNamespace: namespace, sessions: input.sessions },
      Effect.succeed(input.live),
    ),
  );
}

test('tmux GC leaves a tmux session owned by a live tmux row alone', async () => {
  const findings = await collect({
    live: [tmuxSession(7)],
    sessions: [{ ptyProcessId: 7, ref: tmuxSession(7), status: 'running' }],
  });

  assert.deepEqual(findings, []);
});

test('tmux GC collects a tmux session whose tmux row is terminal', async () => {
  const findings = await collect({
    live: [tmuxSession(7)],
    sessions: [{ ptyProcessId: 7, ref: tmuxSession(7), status: 'killed' }],
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.type, 'terminal_backend_session');
});

test('tmux GC collects a tmux session whose id collides with a non-tmux row', async () => {
  // The session name embeds a PTY id, but the row with that id is a node-pty
  // incarnation, so it does not own this tmux session. Reading the id match as
  // ownership used to strand the session forever — and backend-session GC is
  // the last backstop for a tmux session that materialized after its creation
  // request was cancelled.
  const findings = await collect({
    live: [tmuxSession(7)],
    sessions: [
      {
        ptyProcessId: 7,
        ref: { schemaVersion: 1, backend: 'node_pty', ptyProcessId: 7, pid: 4242 },
        status: 'running',
      },
    ],
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.type, 'orphan_backend_session');
  assert.equal(findings[0]?.ptyProcessId, 7);
});

test('tmux GC collects a tmux session with no persisted row at all', async () => {
  const findings = await collect({ live: [tmuxSession(7)], sessions: [] });

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.type, 'orphan_backend_session');
});

test('tmux GC ignores sessions outside this runtime namespace', async () => {
  const findings = await collect({
    live: [{ schemaVersion: 1, backend: 'tmux', sessionName: 'isagi_other-runtime_7' }],
    sessions: [],
  });

  assert.deepEqual(findings, []);
});
