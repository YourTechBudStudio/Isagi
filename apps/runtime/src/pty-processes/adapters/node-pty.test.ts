import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';
import type * as nodePty from 'node-pty';

import {
  NodePtyBackend,
  NodePtyBackendLive,
  nodePtyLaunchCommand,
  spawnNodePty,
  terminalProbeResponses,
} from './node-pty.js';

test('node-pty backend preserves structured command arguments', () => {
  assert.deepEqual(nodePtyLaunchCommand('pi', ['-e', '/tmp/ext.ts', '--session', 'abc$(nope)']), {
    command: 'pi',
    args: ['-e', '/tmp/ext.ts', '--session', 'abc$(nope)'],
  });
});

test('node-pty backend launch boundary passes structured args to spawn', () => {
  const calls: Array<{
    readonly command: string;
    readonly args: readonly string[];
    readonly options: nodePty.IPtyForkOptions;
  }> = [];
  const fakePty = {
    pid: 123,
    process: 'pi',
    handleFlowControl: false,
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
    write: () => {},
    resize: () => {},
    clear: () => {},
    pause: () => {},
    resume: () => {},
    kill: () => {},
  } as unknown as nodePty.IPty;

  const spawned = spawnNodePty(
    {
      ptyProcessId: 1,
      backendSessionName: null,
      command: 'pi',
      args: ['-e', '/tmp/ext.ts', '--session', 'abc$(nope)'],
      cwd: '/repo/isagi',
      env: { PATH: '/bin' },
      cols: 80,
      rows: 24,
      logPath: null,
      onExit: () => {},
    },
    ((command, args, options) => {
      calls.push({ command, args: Array.isArray(args) ? args : [args], options });
      return fakePty;
    }) as typeof nodePty.spawn,
  );

  assert.equal(spawned, fakePty);
  assert.deepEqual(calls, [
    {
      command: 'pi',
      args: ['-e', '/tmp/ext.ts', '--session', 'abc$(nope)'],
      options: {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: '/repo/isagi',
        env: { PATH: '/bin' },
      },
    },
  ]);
});

test('node-pty terminal probe responder answers standard terminal queries', () => {
  assert.deepEqual(
    terminalProbeResponses('\x1b[c\x1b[>c\x1b[5n\x1b[6n\x1b[?6n\x1b[18t', {
      cols: 100,
      rows: 30,
    }),
    ['\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[0n', '\x1b[1;1R', '\x1b[?1;1R', '\x1b[8;30;100t'],
  );
});

test('node-pty terminal probe responder answers OSC color queries', () => {
  assert.deepEqual(
    terminalProbeResponses('\x1b]10;?\x07\x1b]11;?\x1b\\', {
      cols: 100,
      rows: 30,
    }),
    ['\x1b]10;rgb:cdd6/cdd6/f4f4\x1b\\', '\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\'],
  );
});

// Absence and signalling are different facts. A caller that binds a stop cause
// to termination may only do so on an affirmative kill, so the adapter must never
// report success for a ref it never had a live handle for.

test('node-pty terminate reports absence rather than a kill it did not perform', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const backend = yield* NodePtyBackend;
      assert.ok(backend.terminate);
      return yield* backend.terminate({
        ref: { schemaVersion: 1, backend: 'node_pty', ptyProcessId: 4_242, pid: null },
        gracefulTimeoutMs: 10,
      });
    }).pipe(Effect.provide(NodePtyBackendLive)),
  );

  assert.deepEqual(result, { terminated: false });
});

test('node-pty kill reports absence rather than a kill it did not perform', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const backend = yield* NodePtyBackend;
      return yield* backend.kill({
        schemaVersion: 1,
        backend: 'node_pty',
        ptyProcessId: 4_243,
        pid: null,
      });
    }).pipe(Effect.provide(NodePtyBackendLive)),
  );

  assert.deepEqual(result, { terminated: false });
});

test('node-pty terminate affirms a kill when it signalled a live handle', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const backend = yield* NodePtyBackend;
      assert.ok(backend.terminate);
      const ref = yield* backend.launch({
        ptyProcessId: 4_244,
        backendSessionName: null,
        command: '/bin/sh',
        args: ['-c', 'sleep 30'],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        cols: 80,
        rows: 24,
        logPath: null,
        onExit: () => {},
      });
      const terminated = yield* backend.terminate({ ref, gracefulTimeoutMs: 20 });
      // The handle is gone afterwards, so a second attempt is honest absence.
      const again = yield* backend.terminate({ ref, gracefulTimeoutMs: 20 });
      return { terminated, again, inspection: yield* backend.inspect(ref) };
    }).pipe(Effect.provide(NodePtyBackendLive)),
  );

  assert.deepEqual(result.terminated, { terminated: true });
  assert.deepEqual(result.again, { terminated: false });
  assert.deepEqual(result.inspection, { status: 'missing' });
});
