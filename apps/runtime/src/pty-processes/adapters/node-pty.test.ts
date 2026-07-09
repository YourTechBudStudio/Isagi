import assert from 'node:assert/strict';
import test from 'node:test';

import type * as nodePty from 'node-pty';

import { nodePtyLaunchCommand, spawnNodePty, terminalProbeResponses } from './node-pty.js';

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
