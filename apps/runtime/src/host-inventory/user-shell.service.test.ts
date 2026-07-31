import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import {
  resolveUserShellEnvironment,
  runUserShellCommand,
  type UserShellCommandResult,
} from './user-shell.service.js';

const environment = { SHELL: '/bin/zsh', PATH: '/bin:/usr/bin' };

test('user-shell runner preserves arguments containing spaces', async () => {
  const result = await Effect.runPromise(
    runUserShellCommand(
      {
        command: 'printf',
        args: ['%s', 'path with spaces'],
        timeoutMs: 2_000,
        maxOutputBytes: 1024,
      },
      environment,
    ),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'path with spaces');
});

test('user-shell runner bounds output and command duration', async () => {
  const bounded = await Effect.runPromise(
    runUserShellCommand(
      { command: 'printf', args: ['%05000d', '1'], timeoutMs: 2_000, maxOutputBytes: 64 },
      environment,
    ),
  );
  assert.equal(bounded.outputTruncated, true);
  assert.equal(Buffer.byteLength(bounded.stdout), 64);

  const timed = await Effect.runPromise(
    runUserShellCommand(
      { command: 'sleep', args: ['1'], timeoutMs: 10, maxOutputBytes: 64 },
      environment,
    ),
  );
  assert.equal(timed.timedOut, true);
});

test('login-shell environment resolution strips runtime controls and keeps discovered user paths', async () => {
  let calls = 0;
  const result = await Effect.runPromise(
    resolveUserShellEnvironment(
      {
        HOME: '/home/developer',
        SHELL: '/bin/zsh',
        PATH: '/usr/bin:/bin',
        HOST: '127.0.0.1',
        PORT: '0',
        ELECTRON_RUN_AS_NODE: '1',
        ISAGI_ALLOWED_ORIGINS: 'file://',
      },
      (_input, launchEnvironment) => {
        calls += 1;
        assert.equal(launchEnvironment.HOST, undefined);
        assert.equal(launchEnvironment.PORT, undefined);
        assert.equal(launchEnvironment.ELECTRON_RUN_AS_NODE, undefined);
        assert.equal(launchEnvironment.ISAGI_ALLOWED_ORIGINS, undefined);
        return Effect.succeed(
          success(
            'HOME=/home/developer\nSHELL=/bin/zsh\nPATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin\nHOST=127.0.0.1\nPORT=0\nELECTRON_RUN_AS_NODE=1\nISAGI_ALLOWED_ORIGINS=file://\n',
          ),
        );
      },
    ),
  );

  assert.equal(calls, 1);
  assert.equal(result._tag, 'Available');
  assert.equal(result.values.PATH, '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin');
  assert.equal(result.values.HOST, undefined);
  assert.equal(result.values.PORT, undefined);
  assert.equal(result.values.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(result.values.ISAGI_ALLOWED_ORIGINS, undefined);
});

test('login-shell environment resolution falls back to its sanitized base environment', async () => {
  const baseEnvironment = {
    HOME: '/home/developer',
    PATH: '/usr/bin:/bin',
  };
  const result = await Effect.runPromise(
    resolveUserShellEnvironment(baseEnvironment, () =>
      Effect.succeed({
        ...success(''),
        exitCode: 1,
        stderr: 'shell startup failed',
      }),
    ),
  );

  assert.deepEqual(result, {
    _tag: 'ProbeFailed',
    values: {
      ...baseEnvironment,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    },
    diagnostic: 'shell startup failed',
  });
});

function success(stdout: string): UserShellCommandResult {
  return {
    exitCode: 0,
    signal: null,
    stdout,
    stderr: '',
    timedOut: false,
    outputTruncated: false,
  };
}
