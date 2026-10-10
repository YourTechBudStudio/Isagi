import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, test } from 'node:test';

import { Effect, Fiber } from 'effect';

import { expectNoProcessMatching, runScoped } from '@isagi/testing';

import {
  coordinates,
  describeOperationalCause,
  describeSafely,
  type SafeDiagnostic,
} from '../diagnostics/index.js';
import { classifyExecFailure, ExecFailed, execCommand } from './exec.js';

/**
 * The shared short-lived command adapter. Its failure classification feeds Git project-root classification, so the
 * precedence cases are pinned exactly as Git's own classifier pins them.
 */

const node = process.execPath;

/** A `sleep` argument nothing else on the machine uses, so `pgrep -f` finds only this test's children. */
const uniqueSleep = () => `30.${process.pid}${Math.floor(Math.random() * 1_000_000)}`;

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

describe('classifyExecFailure precedence', () => {
  test('an abort is recognized by name, ahead of every other field', () => {
    assert.deepEqual(classifyExecFailure({ name: 'AbortError', signal: 'SIGTERM', code: 128 }), {
      kind: 'aborted',
    });
  });

  test('a signal outranks a code', () => {
    assert.deepEqual(classifyExecFailure({ signal: 'SIGKILL', code: 128 }), {
      kind: 'signalled',
      signal: 'SIGKILL',
    });
  });

  test('a numeric code is an ordinary exit', () => {
    assert.deepEqual(classifyExecFailure({ code: 128 }), { kind: 'exited', exitCode: 128 });
  });

  test('a string code is a launch failure and carries the system code', () => {
    assert.deepEqual(classifyExecFailure({ code: 'ENOENT' }), {
      kind: 'spawn_failed',
      systemErrorCode: 'ENOENT',
    });
  });

  test('unrecognized causes land in the conservative bucket', () => {
    for (const cause of [
      null,
      undefined,
      'a string',
      42,
      new Error('no fields'),
      {},
      { code: '' },
    ]) {
      assert.deepEqual(
        classifyExecFailure(cause),
        { kind: 'spawn_failed', systemErrorCode: null },
        `unexpected classification for ${String(cause)}`,
      );
    }
  });
});

describe('execCommand', () => {
  test('a successful command returns its output', async () => {
    const result = await runScoped(
      execCommand(node, ['-e', 'process.stdout.write("out"); process.stderr.write("err")']),
    );
    assert.deepEqual(result, { stdout: 'out', stderr: 'err' });
  });

  test('a nonzero exit fails with the exit code and the output written so far', async () => {
    const error = await runScoped(
      Effect.flip(
        execCommand(node, [
          '-e',
          'process.stdout.write("partial"); console.error("no"); process.exit(3)',
        ]),
      ),
    );
    assert.ok(error instanceof ExecFailed);
    assert.deepEqual(error.failure, { kind: 'exited', exitCode: 3 });
    assert.equal(error.stdout, 'partial');
    assert.equal(error.stderr, 'no\n');
    assert.equal(error.message, `${node} exited with code 3`);
  });

  test('an unlaunchable command is a spawn failure, not an exit', async () => {
    const error = await runScoped(
      Effect.flip(execCommand('/definitely/not/a/command', [], { cwd: process.cwd() })),
    );
    assert.deepEqual(error.failure, { kind: 'spawn_failed', systemErrorCode: 'ENOENT' });
    assert.equal(error.command, '/definitely/not/a/command');
    assert.equal(error.cwd, process.cwd());
  });

  test('env is merged over the inherited environment and unsetEnv removes inherited variables', async () => {
    const script =
      'process.stdout.write(JSON.stringify({ added: process.env.ISAGI_EXEC_TEST, path: process.env.PATH ?? null }))';

    const merged = await runScoped(
      execCommand(node, ['-e', script], { env: { ISAGI_EXEC_TEST: 'yes' } }),
    );
    assert.deepEqual(JSON.parse(merged.stdout), { added: 'yes', path: process.env.PATH ?? null });

    const unset = await runScoped(
      execCommand(node, ['-e', script], {
        unsetEnv: ['PATH'],
        env: { ISAGI_EXEC_TEST: 'yes' },
      }),
    );
    assert.deepEqual(JSON.parse(unset.stdout), { added: 'yes', path: null });
  });

  test('cwd is the child working directory', async () => {
    const result = await runScoped(
      execCommand(node, ['-e', 'process.stdout.write(process.cwd())'], { cwd: '/' }),
    );
    assert.equal(result.stdout, '/');
  });

  test('a timed-out command is killed and reported as signalled', async () => {
    const marker = uniqueSleep();
    const error = await runScoped(
      Effect.flip(execCommand('sleep', [marker], { timeout: '100 millis' })),
    );
    assert.deepEqual(error.failure, { kind: 'signalled', signal: 'SIGTERM' });
    await runScoped(expectNoProcessMatching(marker));
  });

  test('interrupting execCommand kills its child process', async () => {
    const marker = uniqueSleep();
    await runScoped(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(execCommand('sleep', [marker]));
        yield* waitForProcess(marker);
        yield* Fiber.interrupt(fiber);
        yield* expectNoProcessMatching(marker);
      }),
    );
  });
});

/** A recognized wrapper, the way `PtyKillError` and friends carry an `ExecFailed` from tmux. */
class KillFailed extends Error implements SafeDiagnostic {
  constructor(
    readonly ptyProcessId: number,
    override readonly cause: unknown,
  ) {
    super('kill failed');
  }

  [describeSafely]() {
    return {
      label: `Kill failed${coordinates({ ptyProcess: this.ptyProcessId })}`,
      cause: this.cause,
    };
  }
}

describe('ExecFailed safe diagnostic', () => {
  const SECRET = 'SUPERSECRETTOKEN12345';

  const failed = (failure: ExecFailed['failure'], command = 'tmux') =>
    new ExecFailed({
      command,
      args: ['send-keys', SECRET],
      cwd: `/Users/${SECRET}`,
      failure,
      stdout: SECRET,
      stderr: SECRET,
      cause: Object.assign(new Error(`Command failed: ${command} send-keys ${SECRET}`), {
        code: 'ENOENT',
      }),
    });

  test('names the executable and the failure kind, and nothing it did not author', () => {
    const cases: ReadonlyArray<readonly [ExecFailed['failure'], string]> = [
      [{ kind: 'exited', exitCode: 1 }, 'tmux exited with code 1'],
      [{ kind: 'signalled', signal: 'SIGTERM' }, 'tmux was killed by SIGTERM'],
      [{ kind: 'aborted' }, 'tmux was aborted'],
      [{ kind: 'spawn_failed', systemErrorCode: 'ENOENT' }, 'tmux could not be started (ENOENT)'],
      [{ kind: 'spawn_failed', systemErrorCode: null }, 'tmux could not be started'],
      // A code or signal outside the allowlists is dropped rather than echoed.
      [{ kind: 'spawn_failed', systemErrorCode: `E${SECRET}` }, 'tmux could not be started'],
      [{ kind: 'signalled', signal: SECRET }, 'tmux was killed by a signal'],
    ];
    for (const [failure, expected] of cases) {
      const rendered = describeOperationalCause(failed(failure));
      assert.equal(rendered, expected);
      assert.ok(!rendered.includes(SECRET));
    }
  });

  test('renders inside a recognized wrapper instead of collapsing to "Error"', () => {
    assert.equal(
      describeOperationalCause(new KillFailed(5, failed({ kind: 'exited', exitCode: 1 }))),
      'Kill failed (ptyProcess=5): tmux exited with code 1',
    );
  });

  test('renders only the base name of an executable path', () => {
    assert.equal(
      describeOperationalCause(failed({ kind: 'exited', exitCode: 2 }, `/Users/${SECRET}/bin/git`)),
      'git exited with code 2',
    );
  });

  test('describes real command failures', async () => {
    const exited = await runScoped(Effect.flip(execCommand('sh', ['-c', 'exit 3'])));
    assert.equal(describeOperationalCause(exited), 'sh exited with code 3');

    const missing = await runScoped(Effect.flip(execCommand('/definitely/not/a/command', [])));
    assert.equal(describeOperationalCause(missing), 'command could not be started (ENOENT)');

    const marker = uniqueSleep();
    const timedOut = await runScoped(
      Effect.flip(execCommand('sleep', [marker], { timeout: '100 millis' })),
    );
    assert.equal(describeOperationalCause(timedOut), 'sleep was killed by SIGTERM');
    await runScoped(expectNoProcessMatching(marker));
  });
});
