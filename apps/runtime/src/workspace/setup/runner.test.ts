import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import { Cause, Effect, Exit, Fiber } from 'effect';

import { expectNoProcessMatching, runScoped } from '@isagi/testing';

import { WorktreeSetupRepository } from './repository.js';
import { runPostCreateSetup } from './runner.js';

function capturingRepository(captured: {
  input?: Parameters<WorktreeSetupRepository['Service']['createRunWithSteps']>[0];
}) {
  return {
    findTrust: () => Effect.succeed(null),
    setTrustedHash: () => Effect.void,
    disableHooks: () => Effect.void,
    createRunWithSteps: (input) =>
      Effect.sync(() => {
        captured.input = input;
        return 42;
      }),
    listRunSteps: () => Effect.succeed([]),
  } satisfies WorktreeSetupRepository['Service'];
}

test('copy hooks preserve relative paths and apply exclude after include', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'isagi-setup-project-'));
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'isagi-setup-worktree-'));
  const captured: {
    input?: Parameters<WorktreeSetupRepository['Service']['createRunWithSteps']>[0];
  } = {};

  try {
    await mkdir(join(projectRoot, 'config', 'nested'), { recursive: true });
    writeFileSync(join(projectRoot, 'config', 'one.local.yaml'), 'one');
    writeFileSync(join(projectRoot, 'config', 'nested', 'two.local.yaml'), 'two');
    writeFileSync(join(projectRoot, 'config', 'nested', 'secret.local.yaml'), 'secret');

    const result = await Effect.runPromise(
      runPostCreateSetup({
        config: {
          postCreate: [
            {
              type: 'copy',
              src: 'config',
              dest: 'copied-config',
              include: ['**/*.local.yaml'],
              exclude: ['**/secret.local.yaml'],
              overwrite: true,
            },
          ],
        },
        hash: 'hash-copy',
        projectRootPath: projectRoot,
        worktreeId: 7,
        worktreePath: worktreeRoot,
      }).pipe(Effect.provideService(WorktreeSetupRepository, capturingRepository(captured))),
    );

    assert.deepEqual(result, { status: 'succeeded', runId: 42 });
    assert.equal(
      readFileSync(join(worktreeRoot, 'copied-config', 'one.local.yaml'), 'utf8'),
      'one',
    );
    assert.equal(
      readFileSync(join(worktreeRoot, 'copied-config', 'nested', 'two.local.yaml'), 'utf8'),
      'two',
    );
    assert.equal(
      existsSync(join(worktreeRoot, 'copied-config', 'nested', 'secret.local.yaml')),
      false,
    );
    assert.equal(captured.input?.steps[0]?.status, 'succeeded');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

async function runCopyHookFixture(
  hook: { readonly src: string; readonly dest: string } & Partial<{
    readonly include: readonly string[];
    readonly exclude: readonly string[];
    readonly overwrite: boolean;
  }>,
  arrange: (roots: { readonly projectRoot: string; readonly worktreeRoot: string }) => void,
  inspect: (fixture: {
    readonly worktreeRoot: string;
    readonly result: Effect.Success<ReturnType<typeof runPostCreateSetup>>;
    readonly step: CreateSetupStepFixture | undefined;
  }) => void,
) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'isagi-setup-project-'));
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'isagi-setup-worktree-'));
  const captured: {
    input?: Parameters<WorktreeSetupRepository['Service']['createRunWithSteps']>[0];
  } = {};

  try {
    arrange({ projectRoot, worktreeRoot });
    const result = await Effect.runPromise(
      runPostCreateSetup({
        config: { postCreate: [{ type: 'copy', overwrite: true, ...hook }] },
        hash: 'hash-copy',
        projectRootPath: projectRoot,
        worktreeId: 7,
        worktreePath: worktreeRoot,
      }).pipe(Effect.provideService(WorktreeSetupRepository, capturingRepository(captured))),
    );
    inspect({ worktreeRoot, result, step: captured.input?.steps[0] });
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
}

type CreateSetupStepFixture = Parameters<
  WorktreeSetupRepository['Service']['createRunWithSteps']
>[0]['steps'][number];

test('copy hooks copy a file source directly to dest', async () => {
  await runCopyHookFixture(
    { src: '.env', dest: 'config/local/.env' },
    ({ projectRoot }) => writeFileSync(join(projectRoot, '.env'), 'TOKEN=1'),
    ({ worktreeRoot, result, step }) => {
      assert.deepEqual(result, { status: 'succeeded', runId: 42 });
      assert.equal(readFileSync(join(worktreeRoot, 'config', 'local', '.env'), 'utf8'), 'TOKEN=1');
      assert.equal(step?.message, 'Copied 1 file.');
    },
  );
});

test('copy hooks skip an existing file dest when overwrite is false', async () => {
  await runCopyHookFixture(
    { src: '.env', dest: '.env', overwrite: false },
    ({ projectRoot, worktreeRoot }) => {
      writeFileSync(join(projectRoot, '.env'), 'TOKEN=project');
      writeFileSync(join(worktreeRoot, '.env'), 'TOKEN=worktree');
    },
    ({ worktreeRoot, result, step }) => {
      assert.deepEqual(result, { status: 'succeeded', runId: 42 });
      assert.equal(readFileSync(join(worktreeRoot, '.env'), 'utf8'), 'TOKEN=worktree');
      assert.equal(step?.message, 'Copied 0 files, skipped 1.');
    },
  );
});

test('copy hooks fail when the source does not exist', async () => {
  await runCopyHookFixture(
    { src: '.env', dest: '.env' },
    () => {},
    ({ result, step }) => {
      assert.equal(result.status, 'failed');
      assert.equal(step?.status, 'failed');
      assert.equal(step?.message, 'copy.src .env does not exist in the project root.');
      assert.equal(step?.src, '.env');
      assert.equal(step?.dest, '.env');
    },
  );
});

test('copy hooks reject include or exclude on a file source', async () => {
  await runCopyHookFixture(
    { src: '.env', dest: '.env', include: ['**/*'] },
    ({ projectRoot }) => writeFileSync(join(projectRoot, '.env'), 'TOKEN=1'),
    ({ worktreeRoot, result, step }) => {
      assert.equal(result.status, 'failed');
      assert.match(step?.message ?? '', /apply to directory sources only/);
      assert.equal(existsSync(join(worktreeRoot, '.env')), false);
    },
  );
});

test('command hooks are interrupted without persisting a setup run', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'isagi-setup-project-'));
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'isagi-setup-worktree-'));
  const captured: {
    input?: Parameters<WorktreeSetupRepository['Service']['createRunWithSteps']>[0];
  } = {};

  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          runPostCreateSetup({
            config: {
              postCreate: [
                {
                  type: 'command',
                  run: 'node -e "setTimeout(() => {}, 10000)"',
                  cwd: '.',
                  timeout: '1h',
                  env: {},
                },
              ],
            },
            hash: 'hash-interrupt',
            projectRootPath: projectRoot,
            worktreeId: 9,
            worktreePath: worktreeRoot,
          }).pipe(Effect.provideService(WorktreeSetupRepository, capturingRepository(captured))),
        );
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));
        yield* Fiber.interrupt(fiber);
      }),
    );

    assert.equal(captured.input, undefined);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('command hook timeout is recorded as a failed setup result', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'isagi-setup-project-'));
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'isagi-setup-worktree-'));
  const captured: {
    input?: Parameters<WorktreeSetupRepository['Service']['createRunWithSteps']>[0];
  } = {};

  try {
    const result = await Effect.runPromise(
      runPostCreateSetup({
        config: {
          postCreate: [
            {
              type: 'command',
              run: 'node -e "setTimeout(() => {}, 1000)"',
              cwd: '.',
              timeout: '10ms',
              env: {},
            },
          ],
        },
        hash: 'hash-command',
        projectRootPath: projectRoot,
        worktreeId: 8,
        worktreePath: worktreeRoot,
      }).pipe(Effect.provideService(WorktreeSetupRepository, capturingRepository(captured))),
    );

    assert.equal(result.status, 'failed');
    assert.equal(result.runId, 42);
    assert.equal(result.status === 'failed' ? result.failedHookType : null, 'command');
    assert.match(result.status === 'failed' ? result.message : '', /timed out/i);
    assert.equal(captured.input?.run.status, 'failed');
    assert.equal(captured.input?.steps[0]?.status, 'failed');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('command hook failure captures merged, ANSI-stripped output', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'isagi-setup-project-'));
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'isagi-setup-worktree-'));
  const captured: {
    input?: Parameters<WorktreeSetupRepository['Service']['createRunWithSteps']>[0];
  } = {};

  // Build a script that writes ANSI-colored lines to both stdout and stderr and
  // exits non-zero. The escape (27) and newline (10) bytes are produced inside
  // the subprocess so this test source stays free of literal control characters.
  const ansiScript = [
    'const e = String.fromCharCode(27), nl = String.fromCharCode(10);',
    "process.stdout.write(e + '[31mout-line' + e + '[39m' + nl);",
    "process.stderr.write(e + '[32merr-line' + e + '[39m' + nl);",
    'process.exit(3);',
  ].join(' ');

  try {
    const result = await Effect.runPromise(
      runPostCreateSetup({
        config: {
          postCreate: [
            { type: 'command', run: `node -e "${ansiScript}"`, cwd: '.', timeout: '30s', env: {} },
          ],
        },
        hash: 'hash-ansi',
        projectRootPath: projectRoot,
        worktreeId: 11,
        worktreePath: worktreeRoot,
      }).pipe(Effect.provideService(WorktreeSetupRepository, capturingRepository(captured))),
    );

    assert.equal(result.status, 'failed');
    const outputExcerpt = result.status === 'failed' ? (result.outputExcerpt ?? '') : '';
    // Both streams are captured in one excerpt...
    assert.match(outputExcerpt, /out-line/);
    assert.match(outputExcerpt, /err-line/);
    // ...with ANSI escape sequences stripped out.
    assert.equal(outputExcerpt.includes(String.fromCharCode(27)), false);
    assert.doesNotMatch(outputExcerpt, /\[3\dm/);
    // The exit summary lands in `message`, not the output body.
    assert.match(result.status === 'failed' ? result.message : '', /exited with 3/i);
    assert.equal(captured.input?.steps[0]?.outputExcerpt, outputExcerpt);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

/**
 * Command hooks run as the leader of their own process group. These tests mark the hook's processes with a `sleep`
 * duration nothing else uses and assert with `pgrep` that none outlive the runner, background children included.
 */
const posixOnly = process.platform === 'win32' ? 'process groups are POSIX-only' : false;
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

/** Runs one command hook in fresh temp roots, capturing what the runner persists. */
const withCommandHook = <A, E>(
  hook: { readonly run: string; readonly timeout: string; readonly cwd?: string },
  use: (
    setup: Effect.Effect<
      Effect.Success<ReturnType<typeof runPostCreateSetup>>,
      Effect.Error<ReturnType<typeof runPostCreateSetup>>
    >,
    captured: { input?: Parameters<WorktreeSetupRepository['Service']['createRunWithSteps']>[0] },
  ) => Effect.Effect<A, E>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => ({
      projectRoot: mkdtempSync(join(tmpdir(), 'isagi-setup-project-')),
      worktreeRoot: mkdtempSync(join(tmpdir(), 'isagi-setup-worktree-')),
    })),
    ({ projectRoot, worktreeRoot }) => {
      const captured: {
        input?: Parameters<WorktreeSetupRepository['Service']['createRunWithSteps']>[0];
      } = {};
      return use(
        runPostCreateSetup({
          config: { postCreate: [{ type: 'command', cwd: '.', env: {}, ...hook }] },
          hash: 'hash-lifecycle',
          projectRootPath: projectRoot,
          worktreeId: 12,
          worktreePath: worktreeRoot,
        }).pipe(Effect.provideService(WorktreeSetupRepository, capturingRepository(captured))),
        captured,
      );
    },
    ({ projectRoot, worktreeRoot }) =>
      Effect.sync(() => {
        rmSync(projectRoot, { recursive: true, force: true });
        rmSync(worktreeRoot, { recursive: true, force: true });
      }),
  );

describe('setup runner child lifecycle', { skip: posixOnly }, () => {
  test('interrupting the setup runner kills its child process', async () => {
    const marker = uniqueSleep();
    await runScoped(
      withCommandHook(
        { run: `sleep ${marker} & sleep ${marker}`, timeout: '1h' },
        (setup, captured) =>
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(setup);
            yield* waitForProcess(marker);
            yield* Fiber.interrupt(fiber);
            const exit = yield* Fiber.await(fiber);
            assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
            yield* expectNoProcessMatching(marker);
            // An interrupted run is not a result: nothing is recorded.
            assert.equal(captured.input, undefined);
          }),
      ),
    );
  });

  test('setup runner timeout fails with the typed timeout error and kills the child', async () => {
    // A caller's deadline (`Effect.timeout` around the run) interrupts it: the failure is the typed `TimeoutError`,
    // and the scope that owns the hook's process group kills the whole group.
    const marker = uniqueSleep();
    await runScoped(
      withCommandHook(
        { run: `sleep ${marker} & sleep ${marker}`, timeout: '1h' },
        (setup, captured) =>
          Effect.gen(function* () {
            const timed = yield* Effect.forkChild(
              Effect.flip(
                setup.pipe(
                  Effect.tap(() => Effect.die('the setup run should not finish')),
                  Effect.timeout('1 second'),
                ),
              ),
            );
            // Proves the deadline lands on a live hook rather than on one that never started.
            yield* waitForProcess(marker);
            const error = yield* Fiber.join(timed);
            assert.ok(Cause.isTimeoutError(error), `unexpected failure: ${String(error)}`);
            yield* expectNoProcessMatching(marker);
            assert.equal(captured.input, undefined);
          }),
      ),
    );
  });

  test('a command hook past its own timeout is terminated, escalated to SIGKILL, and recorded as failed', async () => {
    // The hook's `timeout` is the runner's deadline: SIGTERM to the group, SIGKILL one second later when the group
    // ignores it, then a failed step that carries the signal and the output written before it.
    const marker = uniqueSleep();
    const { result, step } = await runScoped(
      withCommandHook(
        { run: `trap '' TERM; echo started; sleep ${marker} & sleep ${marker}`, timeout: '300ms' },
        (setup, captured) =>
          setup.pipe(
            Effect.map((outcome) => ({ result: outcome, step: captured.input?.steps[0] })),
          ),
      ),
    );
    assert.equal(result.status, 'failed');
    assert.match(result.status === 'failed' ? result.message : '', /timed out after 300ms/);
    assert.equal(step?.status, 'failed');
    assert.equal(step?.signal, 'SIGKILL');
    assert.equal(step?.outputExcerpt, 'started\n');
    await runScoped(expectNoProcessMatching(marker));
  });

  test('a command hook whose shell cannot start is recorded as a failed step with the spawn error', async () => {
    const { result, step } = await runScoped(
      withCommandHook({ run: 'true', timeout: '5s', cwd: 'missing-directory' }, (setup, captured) =>
        setup.pipe(Effect.map((outcome) => ({ result: outcome, step: captured.input?.steps[0] }))),
      ),
    );
    assert.equal(result.status, 'failed');
    assert.equal(step?.status, 'failed');
    assert.match(step?.message ?? '', /ENOENT/);
  });
});
