import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, test } from 'node:test';

import { Effect, Fiber, Option } from 'effect';

import { expectNoProcessMatching, runScoped } from '@isagi/testing';

import { ProcessSpawnFailed, spawnProcessGroup, terminateGroup } from './process-group.js';

/**
 * The process-group adapter is the lifecycle guarantee behind user-shell probes and worktree setup hooks: nothing it
 * starts may outlive its scope, including children the command started in the background. Every test marks its
 * processes with a `sleep` duration nothing else uses and asserts with `pgrep` that none survive.
 */

const posixOnly = process.platform === 'win32' ? 'process groups are POSIX-only' : false;

/** A `sleep` argument nothing else on the machine uses. */
const uniqueSleep = () => `30.${process.pid}${Math.floor(Math.random() * 1_000_000)}`;

const countProcesses = (marker: string) => {
  try {
    return execFileSync('pgrep', ['-f', marker.replace(/\./g, '\\.')], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.trim() !== '').length;
  } catch {
    return 0;
  }
};

/** Waits (real time) until `count` processes carry `marker`, so interruption is proven against live processes. */
const waitForProcesses = (marker: string, count: number) =>
  Effect.promise(async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (countProcesses(marker) >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`expected ${count} processes matching ${marker}`);
  });

const collectOutput = () => {
  const chunks = { stdout: '', stderr: '' };
  return {
    chunks,
    onOutput: (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      chunks[stream] += chunk.toString('utf8');
    },
  };
};

describe('spawnProcessGroup', { skip: posixOnly }, () => {
  test('a command that finishes reports its exit and every output chunk', async () => {
    const output = collectOutput();
    const exit = await runScoped(
      Effect.gen(function* () {
        const group = yield* spawnProcessGroup({
          command: 'echo out; echo err 1>&2; exit 4',
          shell: true,
          cwd: process.cwd(),
          env: process.env,
          onOutput: output.onOutput,
        });
        assert.equal(typeof group.pid, 'number');
        return yield* group.exit;
      }),
    );
    assert.deepEqual(exit, { exitCode: 4, signal: null });
    assert.deepEqual(output.chunks, { stdout: 'out\n', stderr: 'err\n' });
  });

  test('args are passed without a shell', async () => {
    const output = collectOutput();
    await runScoped(
      Effect.gen(function* () {
        const group = yield* spawnProcessGroup({
          command: process.execPath,
          args: [
            '-e',
            'process.stdout.write(process.argv[1] + process.env.ISAGI_GROUP_TEST)',
            '$HOME',
          ],
          cwd: process.cwd(),
          env: { ...process.env, ISAGI_GROUP_TEST: '-env' },
          onOutput: output.onOutput,
        });
        return yield* group.exit;
      }),
    );
    assert.equal(output.chunks.stdout, '$HOME-env');
  });

  test('a timeout followed by terminateGroup kills the whole group and keeps partial output', async () => {
    const marker = uniqueSleep();
    const output = collectOutput();
    const result = await runScoped(
      Effect.gen(function* () {
        const group = yield* spawnProcessGroup({
          command: `echo started; sleep ${marker} & sleep ${marker}`,
          shell: true,
          cwd: process.cwd(),
          env: process.env,
          onOutput: output.onOutput,
        });
        yield* waitForProcesses(marker, 2);
        const settled = yield* Effect.timeoutOption(group.exit, '200 millis');
        assert.ok(Option.isNone(settled), 'the command should still be running');
        yield* terminateGroup(group, '1 second');
        return yield* group.exit;
      }),
    );
    assert.equal(result.signal, 'SIGTERM');
    assert.equal(output.chunks.stdout, 'started\n');
    await runScoped(expectNoProcessMatching(marker));
  });

  test('terminateGroup escalates to SIGKILL when the group ignores SIGTERM', async () => {
    const marker = uniqueSleep();
    const result = await runScoped(
      Effect.gen(function* () {
        const group = yield* spawnProcessGroup({
          // An ignored SIGTERM is inherited by the children, so the whole group ignores it.
          command: `trap '' TERM; sleep ${marker} & sleep ${marker}`,
          shell: true,
          cwd: process.cwd(),
          env: process.env,
          onOutput: () => {},
        });
        yield* waitForProcesses(marker, 2);
        yield* terminateGroup(group, '200 millis');
        return yield* group.exit;
      }),
    );
    assert.equal(result.signal, 'SIGKILL');
    await runScoped(expectNoProcessMatching(marker));
  });

  test('interrupting the caller kills the group, background children included', async () => {
    const marker = uniqueSleep();
    await runScoped(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.scoped(
            spawnProcessGroup({
              command: `sleep ${marker} & sleep ${marker}`,
              shell: true,
              cwd: process.cwd(),
              env: process.env,
              onOutput: () => {},
            }).pipe(Effect.flatMap((group) => group.exit)),
          ),
        );
        yield* waitForProcesses(marker, 2);
        yield* Fiber.interrupt(fiber);
        yield* expectNoProcessMatching(marker);
      }),
    );
  });

  test('signalling a group whose leader already exited is not an error', async () => {
    const output = collectOutput();
    const exit = await runScoped(
      Effect.gen(function* () {
        const group = yield* spawnProcessGroup({
          command: 'echo done',
          shell: true,
          cwd: process.cwd(),
          env: process.env,
          onOutput: output.onOutput,
        });
        const leaderExit = yield* group.exit;
        yield* group.signal('SIGTERM');
        return leaderExit;
      }),
    );
    assert.deepEqual(exit, { exitCode: 0, signal: null });
    assert.equal(output.chunks.stdout, 'done\n');
  });

  test('a missing executable fails with ProcessSpawnFailed carrying ENOENT and leaves no process', async () => {
    const marker = `isagi-missing-${uniqueSleep()}`;
    const error = await runScoped(
      Effect.flip(
        spawnProcessGroup({
          command: `/definitely/not/here/${marker}`,
          cwd: process.cwd(),
          env: process.env,
          onOutput: () => {},
        }).pipe(Effect.flatMap((group) => group.exit)),
      ),
    );
    assert.ok(error instanceof ProcessSpawnFailed);
    assert.equal(error.systemErrorCode, 'ENOENT');
    assert.equal(error.command, `/definitely/not/here/${marker}`);
    await runScoped(expectNoProcessMatching(marker));
  });

  test('an invalid spawn argument fails with ProcessSpawnFailed instead of a defect', async () => {
    const error = await runScoped(
      Effect.flip(
        spawnProcessGroup({
          command: 'echo',
          cwd: process.cwd(),
          env: { ...process.env, BROKEN: 'nul\u0000byte' },
          onOutput: () => {},
        }),
      ),
    );
    assert.ok(error instanceof ProcessSpawnFailed);
    assert.equal(error.systemErrorCode, 'ERR_INVALID_ARG_VALUE');
  });
});
