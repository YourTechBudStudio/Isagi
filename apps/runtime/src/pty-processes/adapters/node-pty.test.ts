import assert from 'node:assert/strict';
import test from 'node:test';

import type * as nodePty from 'node-pty';

import { nodePtyLaunchCommand, spawnNodePty } from './node-pty.js';

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
