import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Exit, Queue, Scope, Stream } from 'effect';
import type * as nodePty from 'node-pty';

import { runScoped } from '@isagi/testing';

import type { LaunchBackendSessionInput, PtyOutputMessage, PtyProcessEvent } from '../types.js';
import {
  NodePtyBackend,
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
    }).pipe(Effect.provide(NodePtyBackend.layer)),
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
    }).pipe(Effect.provide(NodePtyBackend.layer)),
  );

  assert.deepEqual(result, { terminated: false });
});

test('node-pty terminate affirms a kill when it signalled a live handle', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const backend = yield* NodePtyBackend;
      assert.ok(backend.terminate);
      const { ref } = yield* backend.launch({
        ptyProcessId: 4_244,
        backendSessionName: null,
        command: '/bin/sh',
        args: ['-c', 'sleep 30'],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        cols: 80,
        rows: 24,
        logPath: null,
      });
      const terminated = yield* backend.terminate({ ref, gracefulTimeoutMs: 20 });
      // The handle is gone afterwards, so a second attempt is honest absence.
      const again = yield* backend.terminate({ ref, gracefulTimeoutMs: 20 });
      return { terminated, again, inspection: yield* backend.inspect(ref) };
    }).pipe(Effect.provide(NodePtyBackend.layer)),
  );

  assert.deepEqual(result.terminated, { terminated: true });
  assert.deepEqual(result.again, { terminated: false });
  assert.deepEqual(result.inspection, { status: 'missing' });
});

// The adapter's callbacks only enqueue: every later fact about a launched process
// arrives on its `events` stream, and live output on the attachment's queue.

function shellLaunch(
  ptyProcessId: number,
  script: string,
  logPath: string | null = null,
): LaunchBackendSessionInput {
  return {
    ptyProcessId,
    backendSessionName: null,
    command: '/bin/sh',
    args: ['-c', script],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    cols: 80,
    rows: 24,
    logPath,
  };
}

const collectEvents = (events: Stream.Stream<PtyProcessEvent>) =>
  Stream.runCollect(events).pipe(Effect.timeout('10 seconds'));

test('a node-pty process that exits reports Exited on its events stream, which then ends', async () => {
  const events = await runScoped(
    Effect.gen(function* () {
      const backend = yield* NodePtyBackend;
      const launched = yield* backend.launch(shellLaunch(4_245, 'exit 3'));
      return yield* collectEvents(launched.events);
    }).pipe(Effect.provide(NodePtyBackend.layer)),
  );

  assert.deepEqual(events.at(-1), { _tag: 'Exited', exitCode: 3, signal: null });
  assert.equal(events.filter((event) => event._tag === 'Exited').length, 1);
});

test('a killed node-pty process ends its events stream without an Exited', async () => {
  const events = await runScoped(
    Effect.gen(function* () {
      const backend = yield* NodePtyBackend;
      const launched = yield* backend.launch(shellLaunch(4_246, 'sleep 30'));
      assert.deepEqual(yield* backend.kill(launched.ref), { terminated: true });
      return yield* collectEvents(launched.events);
    }).pipe(Effect.provide(NodePtyBackend.layer)),
  );

  // The kill owns this incarnation's terminal fact; the stream still ends so its supervisor can finish.
  assert.deepEqual(
    events.filter((event) => event._tag === 'Exited'),
    [],
  );
});

test('a node-pty attachment replays nothing twice, receives live output and exit, and detaches with its scope', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-node-pty-attach-'));
  const logPath = join(root, 'process.ptylog');
  try {
    const result = await runScoped(
      Effect.gen(function* () {
        const backend = yield* NodePtyBackend;
        const launched = yield* backend.launch(
          shellLaunch(
            4_247,
            'printf before; read line; printf "after:%s" "$line"; exit 0',
            logPath,
          ),
        );
        // Wait until the pre-attach output is in the log.
        yield* Effect.sleep('20 millis').pipe(
          Effect.repeat({ until: () => readFileSync(logPath, 'utf8').includes('before') }),
          Effect.timeout('10 seconds'),
        );
        const output = yield* Queue.unbounded<PtyOutputMessage>();
        const foreground = yield* Queue.unbounded<'idle' | 'working'>();
        const scope = yield* Scope.make();
        const attachment = yield* backend
          .attach({ ref: launched.ref, cols: 80, rows: 24, output, foreground })
          .pipe(Scope.provide(scope));
        const replayBytes = attachment.replayBytes;
        yield* attachment.write('x\n');
        const messages = yield* Stream.fromQueue(output).pipe(
          Stream.takeUntil((message) => message.type === 'exit'),
          Stream.runCollect,
          Effect.timeout('10 seconds'),
        );
        yield* Scope.close(scope, Exit.void);
        // Detached: the queue gets nothing more, even from a later write attempt's echo.
        const afterDetach = yield* Queue.size(output);
        return { replayBytes, messages, afterDetach };
      }).pipe(Effect.provide(NodePtyBackend.layer)),
    );

    assert.equal(result.replayBytes, Buffer.byteLength('before'));
    const live = result.messages
      .flatMap((message) => (message.type === 'output' ? [message.data] : []))
      .join('');
    assert.doesNotMatch(live, /before/);
    assert.match(live, /after:x/);
    assert.deepEqual(result.messages.at(-1), { type: 'exit', exitCode: 0, signal: null });
    assert.equal(result.afterDetach, 0);
    assert.equal(statSync(logPath).size >= Buffer.byteLength('beforeafter:x'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
