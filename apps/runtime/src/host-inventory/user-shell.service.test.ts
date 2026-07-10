import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import { runUserShellCommand } from './user-shell.service.js';

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
