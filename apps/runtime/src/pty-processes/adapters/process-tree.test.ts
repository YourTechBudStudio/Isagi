import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Fiber } from 'effect';

import type { BackendSessionRef, PtyBackend } from '../types.js';
import { NodePtyBackend, NodePtyBackendLive } from './node-pty.js';
import { leakyRootScript, leakyTreeFixture, waitUntilGone } from './process-tree-test-support.js';
import {
  parseProcessTable,
  processTreeSurvivors,
  selectProcessTree,
  sweepProcessTreeSurvivors,
  type ProcessTableRow,
} from './process-tree.js';

const started = 'Thu Sep 25 10:12:33 2026';

function row(pid: number, ppid: number, pgid: number, startedAt = started): ProcessTableRow {
  return { pid, ppid, pgid, startedAt };
}

test('process table parsing keeps the multi-word start time as one identity field', () => {
  assert.deepEqual(
    parseProcessTable(
      `  100     1   100 Thu Sep 25 10:12:33 2026\n  101   100   100 Thu Sep 25 10:12:34 2026\n\n`,
    ),
    [row(100, 1, 100), row(101, 100, 100, 'Thu Sep 25 10:12:34 2026')],
  );
});

test('a tree covers descendants that left the root group and group members already re-parented', () => {
  const snapshot = selectProcessTree(
    [
      row(100, 50, 100), // root
      row(101, 100, 100), // child in the root group
      row(102, 101, 200), // grandchild that started its own group
      row(103, 102, 200), // its child
      row(104, 1, 100), // group member whose parent already exited
      row(105, 104, 300), // descendant of that re-parented member
      row(900, 1, 900), // unrelated
    ],
    7,
    100,
  );

  assert.equal(snapshot.root?.pid, 100);
  assert.deepEqual(
    snapshot.descendants.map((entry) => entry.pid).sort(),
    [101, 102, 103, 104, 105],
  );
});

test('survivors match by identity, so a reused pid is never signalled', () => {
  const snapshot = selectProcessTree([row(100, 50, 100), row(101, 100, 200)], 7, 100);

  const survivors = processTreeSurvivors(snapshot, [
    row(101, 1, 200, 'Thu Sep 25 11:00:00 2026'), // pid 101 reused by a stranger
    row(900, 1, 900),
  ]);

  assert.deepEqual(survivors, []);
});

test('survivors include the same processes still alive and late joiners of the root group', () => {
  const snapshot = selectProcessTree([row(100, 50, 100), row(101, 100, 200)], 7, 100);

  const survivors = processTreeSurvivors(snapshot, [
    row(101, 1, 200), // snapshotted descendant, re-parented after the root died
    row(150, 1, 100, 'Thu Sep 25 10:12:40 2026'), // joined the root group later
    row(900, 1, 900),
  ]);

  assert.deepEqual(
    survivors.map((entry) => entry.pid),
    [101, 150],
  );
});

test('a reused root pid voids group membership, since the group id now names someone else', () => {
  const snapshot = selectProcessTree([row(100, 50, 100)], 7, 100);

  const survivors = processTreeSurvivors(snapshot, [
    row(100, 1, 100, 'Thu Sep 25 11:00:00 2026'),
    row(151, 100, 100, 'Thu Sep 25 11:00:01 2026'),
  ]);

  assert.deepEqual(survivors, []);
});

test('a sweep claims only the kills it delivered, never a root whose signal failed', () => {
  const snapshot = selectProcessTree([row(100, 50, 100), row(101, 100, 200)], 7, 100);
  const rows = [row(100, 50, 100), row(101, 1, 200)];
  const signalled: number[] = [];

  // The root exited (ESRCH) or refused the signal (EPERM) after `ps` saw it.
  const rootFailed = sweepProcessTreeSurvivors(snapshot, rows, (pid) => {
    signalled.push(pid);
    return pid !== 100;
  });
  const bothDelivered = sweepProcessTreeSurvivors(snapshot, rows, () => true);

  assert.deepEqual(signalled.sort(), [100, 101]);
  assert.deepEqual(rootFailed, { killedPids: [101], killedRoot: false });
  assert.deepEqual(bothDelivered, { killedPids: [100, 101], killedRoot: true });
});

for (const operation of ['terminate', 'kill'] as const) {
  test(
    `node-pty ${operation} leaves no detached, signal-ignoring descendant behind`,
    { skip: process.platform === 'win32' },
    async () => {
      const fixture = leakyTreeFixture();
      try {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const backend = yield* NodePtyBackend;
            const ref = yield* launchLeakyRoot(
              backend,
              operation === 'terminate' ? 5_101 : 5_102,
              fixture.pidFile,
            );
            const helperPid = yield* Effect.promise(fixture.waitForHelperPid);
            const stopped = yield* stopWith(backend, operation, ref);
            return { stopped, helperPid };
          }).pipe(Effect.provide(NodePtyBackendLive)),
        );

        assert.deepEqual(result.stopped, { terminated: true });
        assert.equal(await waitUntilGone(result.helperPid), true);
      } finally {
        fixture.cleanup();
      }
    },
  );
}

// Cancellation reaches the backend call through the caller's `restore`. Once
// the root has been signalled, cancelling must not skip the escalation and the
// sweep, or the helper that ignored SIGTERM would be stranded.
test(
  'cancelling a node-pty terminate mid-grace still sweeps the descendants',
  { skip: process.platform === 'win32' },
  async () => {
    const fixture = leakyTreeFixture();
    try {
      const helperPid = await Effect.runPromise(
        Effect.gen(function* () {
          const backend = yield* NodePtyBackend;
          assert.ok(backend.terminate);
          const ref = yield* launchLeakyRoot(backend, 5_103, fixture.pidFile);
          const pid = yield* Effect.promise(fixture.waitForHelperPid);
          const fiber = yield* Effect.fork(backend.terminate({ ref, gracefulTimeoutMs: 500 }));
          yield* Effect.sleep(100);
          yield* Fiber.interrupt(fiber);
          return pid;
        }).pipe(Effect.provide(NodePtyBackendLive)),
      );

      assert.equal(await waitUntilGone(helperPid), true);
    } finally {
      fixture.cleanup();
    }
  },
);

function launchLeakyRoot(backend: PtyBackend, ptyProcessId: number, pidFile: string) {
  return backend.launch({
    ptyProcessId,
    backendSessionName: null,
    command: process.execPath,
    args: ['-e', leakyRootScript, pidFile],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    cols: 80,
    rows: 24,
    logPath: null,
    onExit: () => {},
  });
}

function stopWith(backend: PtyBackend, operation: 'terminate' | 'kill', ref: BackendSessionRef) {
  if (operation === 'kill') return backend.kill(ref);
  assert.ok(backend.terminate);
  return backend.terminate({ ref, gracefulTimeoutMs: 100 });
}
