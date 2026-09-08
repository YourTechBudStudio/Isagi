import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { Cause, Effect, Exit, Layer, Option } from 'effect';

import { Git, GitCommandError, type GitCommandFailure, type GitService } from './git.command.js';
import {
  classifyProjectRoot,
  normalizeExistingDirectory,
  ProjectPathValidationError,
  type ProjectPathValidationCode,
} from './project-root.js';
import { removeTree } from './tests/fixtures.js';

/**
 * What the classifier does when Git does not give a clean answer.
 *
 * The single property every case here defends: a folder verdict requires a
 * *normal* Git refusal. Nothing else — a launch failure, a signal, an abort,
 * another exit code, or output this build does not recognize — may produce one,
 * because a wrong folder verdict is stored immutably and cannot be repaired.
 */

interface ProbeCall {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>> | undefined;
}

const CLASSIFICATION_ENV = { LC_ALL: 'C', LANG: 'C', LANGUAGE: 'C' };

function commandError(args: readonly string[], failure: GitCommandFailure, stderr: string) {
  return new GitCommandError({ args, cause: new Error(stderr), cwd: undefined, failure, stderr });
}

/**
 * Answers probes from a table keyed by the git subcommand, and records every
 * call so the pinned environment can be asserted from the outside rather than by
 * exporting a constant purely for tests to read.
 */
function recordingGit(
  responses: Readonly<Record<string, string | GitCommandFailure>>,
  stderrFor: Readonly<Record<string, string>> = {},
) {
  const calls: ProbeCall[] = [];
  const service: GitService = {
    run: (args, options = {}) => {
      calls.push({ args, env: options.env });
      const key = args[args.length - 1] ?? '';
      const response = responses[key];
      if (response === undefined) {
        return Effect.die(new Error(`unexpected probe: git ${args.join(' ')}`));
      }
      if (typeof response === 'string') {
        return Effect.succeed({ stdout: response, stderr: '' });
      }
      return Effect.fail(commandError(args, response, stderrFor[key] ?? ''));
    },
  };
  return { calls, layer: Layer.succeed(Git, service) };
}

let root: string;

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-git-failures-')));
});

after(() => {
  removeTree(root);
});

function directory(name: string, withGitDirectory = false) {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  if (withGitDirectory) {
    mkdirSync(join(path, '.git'), { recursive: true });
  }
  return path;
}

async function classifyWith(path: string, layer: Layer.Layer<GitService>) {
  const target = await Effect.runPromise(normalizeExistingDirectory(path));
  return Effect.runPromiseExit(classifyProjectRoot(target).pipe(Effect.provide(layer)));
}

function expectCode(
  exit: Exit.Exit<unknown, ProjectPathValidationError>,
  code: ProjectPathValidationCode,
) {
  assert.ok(Exit.isFailure(exit), 'expected a refusal, but classification succeeded');
  const failure = Option.getOrNull(Cause.failureOption(exit.cause));
  assert.ok(
    failure instanceof ProjectPathValidationError,
    `unexpected cause: ${String(exit.cause)}`,
  );
  assert.equal(failure.code, code, `unexpected rejection: ${failure.message}`);
  return failure;
}

describe('no injected failure yields a folder', () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly failure: GitCommandFailure;
    readonly stderr: string;
    readonly expected: ProjectPathValidationCode;
  }> = [
    {
      name: 'git could not be launched at all',
      failure: { kind: 'spawn_failed', systemErrorCode: 'ENOENT' },
      stderr: '',
      expected: 'git_unavailable',
    },
    {
      name: 'an unrecognized cause falls into the conservative spawn bucket',
      failure: { kind: 'spawn_failed', systemErrorCode: null },
      stderr: 'fatal: not a git repository (or any of the parent directories): .git',
      expected: 'git_unavailable',
    },
    {
      name: 'exit 128 with unrelated stderr',
      failure: { kind: 'exited', exitCode: 128 },
      stderr: 'fatal: detected dubious ownership in repository',
      expected: 'git_command_failed',
    },
    {
      name: 'exit 129 carrying the non-repository message',
      failure: { kind: 'exited', exitCode: 129 },
      stderr: 'fatal: not a git repository (or any of the parent directories): .git',
      expected: 'git_command_failed',
    },
    {
      name: 'the child was killed by a signal',
      failure: { kind: 'signalled', signal: 'SIGKILL' },
      stderr: '',
      expected: 'git_command_failed',
    },
    {
      name: 'the probe was aborted',
      failure: { kind: 'aborted' },
      stderr: '',
      expected: 'git_command_failed',
    },
  ];

  for (const scenario of cases) {
    test(scenario.name, async () => {
      // The directory is an ordinary folder with no metadata anywhere above it,
      // so corroboration would say `absent`: only the failure evidence is
      // standing between this path and a folder verdict.
      const path = directory(`negative-${scenario.expected}-${scenario.failure.kind}`);
      const { layer } = recordingGit(
        { '--is-bare-repository': scenario.failure },
        { '--is-bare-repository': scenario.stderr },
      );
      expectCode(await classifyWith(path, layer), scenario.expected);
    });
  }

  test('a later probe failing never reopens the folder branch', async () => {
    const path = directory('later-probe-failure');
    const { layer } = recordingGit({
      '--is-bare-repository': 'false',
      '--show-toplevel': { kind: 'spawn_failed', systemErrorCode: 'EACCES' },
    });
    expectCode(await classifyWith(path, layer), 'git_unavailable');
  });
});

describe('unexpected probe output is inconclusive, never a verdict', () => {
  test('a non-boolean answer from the first probe', async () => {
    const path = directory('unexpected-bare-output');
    const { layer } = recordingGit({ '--is-bare-repository': 'maybe' });
    expectCode(await classifyWith(path, layer), 'git_command_failed');
  });

  test('empty top-level output is rejected before it can be resolved', async () => {
    // Left unchecked this normalizes to the home directory, which would compare
    // equal for a candidate at `$HOME` and produce a false `git` verdict.
    const path = directory('empty-toplevel');
    const { layer } = recordingGit({ '--is-bare-repository': 'false', '--show-toplevel': '   ' });
    const failure = expectCode(await classifyWith(path, layer), 'git_command_failed');
    assert.match(failure.message, /--show-toplevel/);
  });

  test('empty common-dir output is rejected before it can be resolved', async () => {
    const path = directory('empty-common-dir', true);
    const { layer } = recordingGit({
      '--is-bare-repository': 'false',
      '--show-toplevel': path,
      '--git-common-dir': '',
    });
    const failure = expectCode(await classifyWith(path, layer), 'git_command_failed');
    assert.match(failure.message, /--git-common-dir/);
  });
});

describe('probe options', () => {
  test('every classification probe pins the C locale, and nothing else is sent', async () => {
    const path = directory('probe-options', true);
    const { calls, layer } = recordingGit({
      '--is-bare-repository': 'false',
      '--show-toplevel': path,
      '--git-common-dir': join(path, '.git'),
    });

    const exit = await classifyWith(path, layer);
    assert.ok(Exit.isSuccess(exit) && exit.value.kind === 'git');

    // Including the common-dir probe, which runs from a different call site.
    const probed = calls.map((call) => call.args[call.args.length - 1]);
    assert.deepEqual(probed, ['--is-bare-repository', '--show-toplevel', '--git-common-dir']);
    for (const call of calls) {
      assert.deepEqual(
        call.env,
        CLASSIFICATION_ENV,
        `git ${call.args.join(' ')} did not carry the pinned locale`,
      );
    }
  });

  test('the pinned locale does not leak into ordinary Git work', async () => {
    const { listGitWorktrees, listLocalBranches } = await import('./git.repository.js');
    const { calls, layer } = recordingGit({ '--porcelain': '', '--format=%(refname:short)': '' });
    await Effect.runPromise(listGitWorktrees(root).pipe(Effect.provide(layer)));
    await Effect.runPromise(listLocalBranches(root).pipe(Effect.provide(layer)));
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(
        call.env,
        undefined,
        `git ${call.args.join(' ')} should inherit the environment`,
      );
    }
  });
});
