import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Fiber } from 'effect';

import {
  WorktreeSetupRepository,
  type WorktreeSetupRepositoryService,
} from './worktree-setup.repository.js';
import { runPostCreateSetup } from './worktree-setup.runner.js';

function capturingRepository(captured: {
  input?: Parameters<WorktreeSetupRepositoryService['createRunWithSteps']>[0];
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
  } satisfies WorktreeSetupRepositoryService;
}

test('copy hooks preserve relative paths and apply exclude after include', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'isagi-setup-project-'));
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'isagi-setup-worktree-'));
  const captured: { input?: Parameters<WorktreeSetupRepositoryService['createRunWithSteps']>[0] } =
    {};

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

test('command hooks are interrupted without persisting a setup run', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'isagi-setup-project-'));
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'isagi-setup-worktree-'));
  const captured: { input?: Parameters<WorktreeSetupRepositoryService['createRunWithSteps']>[0] } =
    {};

  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
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
  const captured: { input?: Parameters<WorktreeSetupRepositoryService['createRunWithSteps']>[0] } =
    {};

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
  const captured: { input?: Parameters<WorktreeSetupRepositoryService['createRunWithSteps']>[0] } =
    {};

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
