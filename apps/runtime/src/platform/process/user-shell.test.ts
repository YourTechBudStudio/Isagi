import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test, { describe } from 'node:test';

import { Cause, Effect, Exit, Fiber } from 'effect';

import { expectNoProcessMatching, makeLogCapture } from '../../../test/test-support.js';
import {
  resolveUserShellEnvironment,
  runUserShellCommand,
  type UserShellCommandResult,
} from './user-shell.js';

const environment = { SHELL: '/bin/zsh', PATH: '/bin:/usr/bin' };

test('user-shell runner preserves arguments containing spaces', async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      runUserShellCommand(
        {
          command: 'printf',
          args: ['%s', 'path with spaces'],
          timeoutMs: 2_000,
          maxOutputBytes: 1024,
        },
        environment,
      ),
    ),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'path with spaces');
});

test('a command name the shell cannot take runs directly and logs why', async () => {
  const logs = makeLogCapture();
  const result = await Effect.runPromise(
    Effect.scoped(
      runUserShellCommand(
        { command: 'printf %s', args: ['x'], timeoutMs: 2_000, maxOutputBytes: 1024 },
        environment,
      ).pipe(Effect.provide(logs.layer)),
    ),
  );
  // Run directly, `printf %s` is not an executable name, so it cannot start.
  assert.equal(typeof result.spawnError, 'string');
  assert.deepEqual(
    logs.lines.map((line) => [line.level, line.message, line.annotations]),
    [
      [
        'Warn',
        'User-shell command fell back to a direct command',
        { command: 'printf %s', reason: 'unsupported_command_name' },
      ],
    ],
  );
});

test('user-shell runner bounds output and command duration', async () => {
  const bounded = await Effect.runPromise(
    Effect.scoped(
      runUserShellCommand(
        { command: 'printf', args: ['%05000d', '1'], timeoutMs: 2_000, maxOutputBytes: 64 },
        environment,
      ),
    ),
  );
  assert.equal(bounded.outputTruncated, true);
  assert.equal(Buffer.byteLength(bounded.stdout), 64);

  const timed = await Effect.runPromise(
    Effect.scoped(
      runUserShellCommand(
        { command: 'sleep', args: ['1'], timeoutMs: 10, maxOutputBytes: 64 },
        environment,
      ),
    ),
  );
  assert.equal(timed.timedOut, true);
});

test('login-shell environment resolution strips runtime controls and keeps discovered user paths', async () => {
  let calls = 0;
  const result = await Effect.runPromise(
    Effect.scoped(
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
    Effect.scoped(
      resolveUserShellEnvironment(baseEnvironment, () =>
        Effect.succeed({
          ...success(''),
          exitCode: 1,
          stderr: 'shell startup failed',
        }),
      ),
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

/**
 * The runner is the lifecycle guarantee behind the startup environment probe: a shell that hangs in its rc files must
 * not outlive the call, and neither may anything it started in the background. Every test marks its processes with a
 * `sleep` duration nothing else uses and asserts with `pgrep` that none survive.
 */
const posixOnly = process.platform === 'win32' ? 'process groups are POSIX-only' : false;
const uniqueSleep = () => `30.${process.pid}${Math.floor(Math.random() * 1_000_000)}`;
const shellEnvironment = { ...process.env, SHELL: '/bin/sh' };

const processRunning = (marker: string) => {
  try {
    execFileSync('pgrep', ['-f', marker.replace(/\./g, '\\.')]);
    return true;
  } catch {
    return false;
  }
};

const waitForProcess = (marker: string) =>
  Effect.promise(async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (processRunning(marker)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`no process matching ${marker} started`);
  });

/** `sleep` in the background and the foreground, so the group has a child beside the shell. */
const sleepingCommand = (marker: string) => ({
  command: 'sh',
  args: ['-c', `sleep ${marker} & sleep ${marker}`],
  maxOutputBytes: 1024,
});

describe('user-shell child lifecycle', { skip: posixOnly }, () => {
  test('interrupting user-shell kills its child process', async () => {
    const marker = uniqueSleep();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            runUserShellCommand(
              { ...sleepingCommand(marker), timeoutMs: 30_000 },
              shellEnvironment,
            ),
          );
          yield* waitForProcess(marker);
          yield* Fiber.interrupt(fiber);
          const exit = yield* Fiber.await(fiber);
          assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
          yield* expectNoProcessMatching(marker);
        }),
      ),
    );
  });

  test('user-shell timeout fails with the typed timeout error and kills the child', async () => {
    // A caller's own deadline (`Effect.timeout` around the run) interrupts it: the failure is the typed
    // `TimeoutError`, and the scope that owns the process group kills the whole group.
    const marker = uniqueSleep();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const timed = yield* Effect.forkChild(
            Effect.flip(
              runUserShellCommand(
                { ...sleepingCommand(marker), timeoutMs: 30_000 },
                shellEnvironment,
              ).pipe(Effect.timeout('1 second')),
            ),
          );
          yield* waitForProcess(marker);
          const error = yield* Fiber.join(timed);
          assert.ok(Cause.isTimeoutError(error), `unexpected failure: ${String(error)}`);
          yield* expectNoProcessMatching(marker);
        }),
      ),
    );
  });

  test('a command past its own deadline reports timedOut and leaves no process behind', async () => {
    // `timeoutMs` is the runner's deadline: not a failure but a described outcome, with the group SIGKILLed.
    const marker = uniqueSleep();
    const result = await Effect.runPromise(
      Effect.scoped(
        runUserShellCommand({ ...sleepingCommand(marker), timeoutMs: 300 }, shellEnvironment),
      ),
    );
    assert.equal(result.timedOut, true);
    assert.equal(result.signal, 'SIGKILL');
    assert.equal(result.spawnError, undefined);
    await Effect.runPromise(Effect.scoped(expectNoProcessMatching(marker)));
  });

  test('a shell that cannot start is described by spawnError, not a failure', async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        runUserShellCommand(
          { command: 'true', args: [], timeoutMs: 2_000, maxOutputBytes: 64 },
          { ...process.env, SHELL: '/definitely/not/a/shell' },
        ),
      ),
    );
    assert.equal(result.exitCode, null);
    assert.equal(result.timedOut, false);
    assert.match(result.spawnError ?? '', /ENOENT/);
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
