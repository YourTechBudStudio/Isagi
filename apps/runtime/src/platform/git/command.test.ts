import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Cause, Effect, Exit, Fiber, Option } from 'effect';

import { expectNoProcessMatching } from '../../../test/test-support.js';
import { Git, GitCommandError } from './command.js';
import { removeTree, requireGit } from './testing.js';

/**
 * The subprocess adapter and the failure discriminant derived from its
 * rejections. Everything above this layer branches on `failure` rather than on
 * stderr text, so getting the derivation wrong would make an unlaunchable `git`
 * indistinguishable from a repository that simply does not exist.
 *
 * The derivation itself is `classifyExecFailure` in `platform/process`, whose
 * precedence is pinned by `platform/process/exec.test.ts`; the cases here prove
 * Git reports what that classifier derives from real git runs.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD = join(HERE, 'tests', 'git-child.ts');

let root: string;

before(() => {
  requireGit();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-git-command-')));
});

after(() => {
  removeTree(root);
});

function run(args: readonly string[], options?: { readonly env?: Record<string, string> }) {
  return Effect.runPromiseExit(
    Effect.gen(function* () {
      const git = yield* Git;
      return yield* git.run(args, options);
    }).pipe(Effect.provide(Git.layer)),
  );
}

/**
 * A git invocation that blocks until killed: `hash-object --stdin` waits for an
 * end of input that never comes, because the adapter leaves the child's stdin
 * open. The `-c` value is a marker nothing else on the machine carries, so
 * `pgrep -f` finds only this test's git.
 */
function blockingGit() {
  const marker = `isagi-git-test-${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
  return { marker, args: ['-c', `isagi.testmarker=${marker}`, 'hash-object', '--stdin'] };
}

function processRunning(marker: string) {
  try {
    execFileSync('pgrep', ['-f', marker]);
    return true;
  } catch {
    return false;
  }
}

function waitForProcess(marker: string) {
  return Effect.promise(async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (processRunning(marker)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`no process matching ${marker} started`);
  });
}

function commandFailure(exit: Exit.Exit<unknown, GitCommandError>) {
  assert.ok(Exit.isFailure(exit), 'expected the git call to fail');
  const failure = Option.getOrNull(Cause.findErrorOption(exit.cause));
  assert.ok(failure instanceof GitCommandError, `unexpected cause: ${String(exit.cause)}`);
  return failure;
}

/**
 * Runs one Git operation in a child process carrying `ambient` in its
 * environment. The runtime's tests share a single process, so mutating
 * `process.env` here would be visible to every other suite for as long as it
 * were set.
 */
function inAmbientEnvironment(ambient: Record<string, string>, request: unknown) {
  const stdout = execFileSync(
    process.execPath,
    ['--import', 'tsx', CHILD, JSON.stringify(request)],
    { cwd: join(HERE, '..', '..'), encoding: 'utf8', env: { ...process.env, ...ambient } },
  );
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>;
}

describe('the live adapter', () => {
  test('a successful command returns its output', async () => {
    const exit = await run(['--version']);
    assert.ok(Exit.isSuccess(exit));
    assert.match(exit.value.stdout, /^git version /);
  });

  test('an ordinary refusal is reported as a normal nonzero exit', async () => {
    const ordinary = join(root, 'ordinary');
    mkdirSync(ordinary, { recursive: true });
    const failure = commandFailure(
      await run(['-C', ordinary, 'rev-parse', '--is-bare-repository']),
    );
    assert.deepEqual(failure.failure, { kind: 'exited', exitCode: 128 });
    assert.match(failure.stderr, /not a git repository/i);
  });

  test('a per-call env override reaches the child', async () => {
    const target = join(root, 'override-git-dir');
    const failure = commandFailure(
      await run(['rev-parse', '--git-dir'], { env: { GIT_DIR: target } }),
    );
    assert.ok(
      failure.stderr.includes(target),
      `expected git to report the overridden GIT_DIR, got ${failure.stderr}`,
    );
  });

  test('variables not named in the override still reach the child', async () => {
    // git ran at all, which requires PATH from the parent environment: the
    // override is merged over `process.env`, not substituted for it.
    const exit = await run(['--version'], { env: { GIT_DIR: join(root, 'anything') } });
    assert.ok(Exit.isSuccess(exit));
  });

  test('an unlaunchable git is a spawn failure, not a refusal', async () => {
    const failure = commandFailure(await run(['--version'], { env: { PATH: '/nonexistent' } }));
    assert.equal(failure.failure.kind, 'spawn_failed');
    assert.equal(
      failure.failure.kind === 'spawn_failed' ? failure.failure.systemErrorCode : null,
      'ENOENT',
    );
  });
});

describe(
  'git child lifecycle',
  { skip: process.platform === 'win32' ? 'uses pgrep' : false },
  () => {
    test('interrupting git kills its child process', async () => {
      const { marker, args } = blockingGit();
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const git = yield* Git;
            const fiber = yield* Effect.forkChild(git.run(args));
            yield* waitForProcess(marker);
            yield* Fiber.interrupt(fiber);
            const exit = yield* Fiber.await(fiber);
            // Interruption is not a failure: no `aborted` GitCommandError reaches the caller.
            assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
            yield* expectNoProcessMatching(marker);
          }).pipe(Effect.provide(Git.layer)),
        ),
      );
    });

    test('git timeout fails with the typed timeout error and kills the child', async () => {
      const { marker, args } = blockingGit();
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const git = yield* Git;
            const timed = yield* Effect.forkChild(
              Effect.flip(
                git.run(args).pipe(
                  Effect.tap(() => Effect.die('git should not finish')),
                  Effect.timeout('1 second'),
                ),
              ),
            );
            // Proves the deadline lands on a live git rather than on one that never started.
            yield* waitForProcess(marker);
            const error = yield* Fiber.join(timed);
            assert.ok(Cause.isTimeoutError(error), `unexpected failure: ${String(error)}`);
            yield* expectNoProcessMatching(marker);
          }).pipe(Effect.provide(Git.layer)),
        ),
      );
    });
  },
);

describe('overrides beat the inherited environment', () => {
  test('a per-call value wins over an ambient one', () => {
    const ambient = join(root, 'ambient-git-dir');
    const override = join(root, 'override-git-dir');
    const result = inAmbientEnvironment(
      { GIT_DIR: ambient },
      { op: 'run', args: ['rev-parse', '--git-dir'], env: { GIT_DIR: override } },
    );
    const stderr = String(result.stderr ?? '');
    assert.ok(stderr.includes(override), `expected the override to win, got ${stderr}`);
    assert.ok(!stderr.includes(ambient), `the ambient value leaked through: ${stderr}`);
  });

  test('a variable named in unsetEnv is removed from the inherited environment', () => {
    const repository = join(root, 'unset-target');
    mkdirSync(repository, { recursive: true });
    execFileSync('git', ['init', '--quiet', repository]);
    const ambient = join(root, 'unset-ambient-git-dir');
    const result = inAmbientEnvironment(
      { GIT_DIR: ambient },
      {
        op: 'run',
        args: ['-C', repository, 'rev-parse', '--absolute-git-dir'],
        unsetEnv: ['GIT_DIR'],
      },
    );
    assert.equal(
      result.ok,
      true,
      `expected the -C repository to be used, got ${JSON.stringify(result)}`,
    );
    const value = result.value as { stdout: string };
    assert.equal(realpathSync(value.stdout.trim()), realpathSync(join(repository, '.git')));
  });

  test('an ambient value survives when the call does not override it', () => {
    const ambient = join(root, 'ambient-only-git-dir');
    const result = inAmbientEnvironment(
      { GIT_DIR: ambient },
      { op: 'run', args: ['rev-parse', '--git-dir'] },
    );
    assert.ok(
      String(result.stderr ?? '').includes(ambient),
      `expected the inherited value to be used, got ${String(result.stderr)}`,
    );
  });
});

describe('classification is immune to the ambient locale', () => {
  test('an ordinary folder classifies the same under a non-C locale', (t) => {
    const ordinary = join(root, 'locale-ordinary');
    mkdirSync(ordinary, { recursive: true });

    const locale = 'fr_FR.UTF-8';
    const translated = gitStderr(ordinary, { LC_ALL: locale, LANG: locale, LANGUAGE: 'fr' });
    const cWording = gitStderr(ordinary, { LC_ALL: 'C', LANG: 'C', LANGUAGE: 'C' });

    // The classifier matches git's C-locale wording. If this git has no message
    // catalog for the locale, an unpinned probe would produce identical English,
    // so the assertion could not distinguish a pinned build from an unpinned one.
    if (translated === cWording) {
      t.skip(`git emits no ${locale} translation on this host, so pinning is not observable here`);
    } else {
      const result = inAmbientEnvironment(
        { LC_ALL: locale, LANG: locale, LANGUAGE: 'fr' },
        { op: 'classify', path: ordinary },
      );
      assert.equal(
        result.ok,
        true,
        `classification failed under ${locale}: ${JSON.stringify(result)}`,
      );
      assert.equal((result.value as { kind?: string }).kind, 'folder');
    }
  });
});

function gitStderr(cwd: string, env: Record<string, string>) {
  try {
    execFileSync('git', ['-C', cwd, 'rev-parse', '--is-bare-repository'], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return '';
  } catch (error) {
    return String((error as { stderr?: string }).stderr ?? '');
  }
}
