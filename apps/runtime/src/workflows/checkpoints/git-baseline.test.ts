import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Effect, Exit } from 'effect';

import { GitCommandError, GitLive, Git, type GitService } from '../../git/git.command.js';
import { createFixtureWorkspace, type FixtureWorkspace } from '../../git/tests/fixtures.js';
import {
  inspectBaseline,
  listBaseLevel,
  listBaseTree,
  readHead,
  surveyDirtyPaths,
} from './git-baseline.js';

const liveGit = Effect.runSync(Git.pipe(Effect.provide(GitLive)));

let workspace: FixtureWorkspace;
let repo: string;
const git = (args: readonly string[]) => workspace.git(repo, args);
const write = (path: string, content: string) => {
  mkdirSync(join(repo, path, '..'), { recursive: true });
  writeFileSync(join(repo, path), content);
};

beforeEach(() => {
  workspace = createFixtureWorkspace('checkpoint-baseline');
  repo = workspace.directory('repo');
  git(['init']);
});
afterEach(() => workspace.cleanup());

const failureOf = async <A>(effect: Effect.Effect<A, { readonly reason: string }>) => {
  const exit = await Effect.runPromiseExit(effect);
  assert.ok(Exit.isFailure(exit) && exit.cause._tag === 'Fail', 'expected a failure');
  return exit.cause.error.reason;
};

/** A `GitService` whose every call fails the given way. */
function failingGit(failure: GitCommandError['failure']): GitService {
  return {
    run: (args) =>
      Effect.fail(
        new GitCommandError({ args, cause: undefined, cwd: undefined, failure, stderr: '' }),
      ),
  };
}

describe('the Git baseline', () => {
  it('reads an unborn repository as a null HEAD with its object format', async () => {
    const baseline = await Effect.runPromise(inspectBaseline(liveGit, repo));
    assert.deepEqual(baseline, { head: null, objectFormat: 'sha1' });
  });

  it('reads a committed HEAD, and a detached HEAD as the same commit', async () => {
    write('a.txt', 'a');
    git(['add', '.']);
    git(['commit', '-m', 'one']);
    const sha = git(['rev-parse', 'HEAD']).trim();
    assert.equal(await Effect.runPromise(readHead(liveGit, repo)), sha);
    git(['checkout', '--detach', 'HEAD']);
    assert.equal(await Effect.runPromise(readHead(liveGit, repo)), sha);
  });

  it('tells Git that could not start apart from a Git read that failed', async () => {
    assert.equal(
      await failureOf(
        readHead(failingGit({ kind: 'spawn_failed', systemErrorCode: 'ENOENT' }), repo),
      ),
      'git_unavailable',
    );
    assert.equal(
      await failureOf(readHead(failingGit({ kind: 'exited', exitCode: 128 }), repo)),
      'git_inspection_failed',
    );
    // Outside any repository `rev-parse` exits 128: a failed read, never "no commit".
    const outside = workspace.directory('plain');
    assert.equal(await failureOf(inspectBaseline(liveGit, outside)), 'git_inspection_failed');
  });

  it('refuses a HEAD that is neither a commit nor an unborn branch', async () => {
    // Exit 1 from rev-parse and no symbolic HEAD: a detached HEAD naming a missing commit.
    const gitAnswering: GitService = {
      run: (args) =>
        Effect.fail(
          new GitCommandError({
            args,
            cause: undefined,
            cwd: undefined,
            failure: { kind: 'exited', exitCode: 1 },
            stderr: '',
          }),
        ),
    };
    assert.equal(await failureOf(readHead(gitAnswering, repo)), 'git_inspection_failed');
  });

  it('lists regular files under literal roots only, dropping links and submodule entries', async () => {
    write('doc/c.md', 'c');
    write('docs/a.md', 'a');
    write('docs/tool.sh', '#!/bin/sh');
    write('[x]/glob.md', 'g');
    write('x/plain.md', 'p');
    symlinkSync('a.md', join(repo, 'docs/link.md'));
    git(['add', '.']);
    git(['update-index', '--chmod=+x', 'docs/tool.sh']);
    git(['update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},docs/module`]);
    git(['commit', '-m', 'tree']);
    const sha = git(['rev-parse', 'HEAD']).trim();

    const docs = await Effect.runPromise(listBaseTree(liveGit, repo, sha, ['docs', 'docs']));
    assert.deepEqual(
      docs.map((entry) => [entry.path, entry.executable]),
      [
        ['docs/a.md', false],
        ['docs/tool.sh', true],
      ],
    );
    assert.match(docs[0]!.objectId, /^[0-9a-f]{40}$/);
    // `[x]` is a literal name, not a character class matching `x`.
    const glob = await Effect.runPromise(listBaseTree(liveGit, repo, sha, ['[x]']));
    assert.deepEqual(
      glob.map((entry) => entry.path),
      ['[x]/glob.md'],
    );
    assert.deepEqual(await Effect.runPromise(listBaseTree(liveGit, repo, sha, [])), []);
    assert.deepEqual(await Effect.runPromise(listBaseLevel(liveGit, repo, sha, '')), [
      '[x]',
      'doc',
      'docs',
      'x',
    ]);
    assert.deepEqual(await Effect.runPromise(listBaseLevel(liveGit, repo, sha, 'docs')), [
      'a.md',
      'link.md',
      'module',
      'tool.sh',
    ]);
  });
});

describe('the dirty survey', () => {
  beforeEach(() => {
    write('tracked/a.md', 'a');
    write('tracked/b.md', 'b');
    git(['add', '.']);
    git(['commit', '-m', 'base']);
  });

  it('reports modified, deleted and untracked paths, collapsing untracked directories', async () => {
    write('tracked/a.md', 'changed');
    rmSync(join(repo, 'tracked/b.md'));
    write('fresh/one.md', '1');
    write('fresh/two.md', '2');
    const survey = await Effect.runPromise(surveyDirtyPaths(liveGit, repo, []));
    assert.deepEqual(survey, {
      ok: true,
      entries: [
        { path: 'tracked/a.md', collapsedDirectory: false },
        { path: 'tracked/b.md', collapsedDirectory: false },
        { path: 'fresh/', collapsedDirectory: true },
      ],
    });
  });

  it('expands a collapsed directory that contains or lies inside a region', async () => {
    write('fresh/one.md', '1');
    write('fresh/inner/two.md', '2');
    write('other/three.md', '3');
    const inside = await Effect.runPromise(
      surveyDirtyPaths(liveGit, repo, [{ path: 'fresh/inner' }]),
    );
    assert.ok(inside.ok);
    assert.deepEqual(
      inside.entries.map((entry) => entry.path),
      ['fresh/inner/two.md', 'fresh/one.md', 'other/'],
    );
    const around = await Effect.runPromise(
      surveyDirtyPaths(liveGit, repo, [{ path: 'other/three.md' }]),
    );
    assert.ok(around.ok);
    assert.deepEqual(
      around.entries.map((entry) => entry.path),
      ['fresh/', 'other/three.md'],
    );
  });

  it('degrades to unavailable, never a failure, when Git cannot answer', async () => {
    const survey = await Effect.runPromise(
      surveyDirtyPaths(failingGit({ kind: 'exited', exitCode: 128 }), repo, []),
    );
    assert.deepEqual(survey, { ok: false });
  });
});

describe('the destination, not the runtime’s environment, decides which repository is read', () => {
  it('ignores an inherited GIT_DIR, work tree and index that point at another repository', () => {
    write('docs/a.md', 'destination');
    git(['add', '.']);
    git(['commit', '-m', 'destination']);
    const destinationHead = git(['rev-parse', 'HEAD']).trim();
    write('docs/a.md', 'dirty in the destination');

    const elsewhere = workspace.directory('elsewhere');
    workspace.git(elsewhere, ['init']);
    writeFileSync(join(elsewhere, 'other.md'), 'elsewhere');
    workspace.git(elsewhere, ['add', '.']);
    workspace.git(elsewhere, ['commit', '-m', 'elsewhere']);
    writeFileSync(join(elsewhere, 'untracked-elsewhere.md'), 'x');

    const here = dirname(fileURLToPath(import.meta.url));
    const stdout = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        join(here, 'tests', 'git-baseline-child.ts'),
        JSON.stringify({ worktreePath: repo, roots: ['docs', 'other.md'] }),
      ],
      {
        cwd: join(here, '..', '..', '..'),
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_DIR: join(elsewhere, '.git'),
          GIT_WORK_TREE: elsewhere,
          GIT_INDEX_FILE: join(elsewhere, '.git', 'index'),
        },
      },
    );
    const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as {
      ok: boolean;
      value?: { head: string; tree: string[]; survey: unknown };
    };
    assert.ok(result.ok, `the checkpoint reads failed: ${stdout}`);
    assert.deepEqual(result.value, {
      head: destinationHead,
      tree: ['docs/a.md'],
      survey: { ok: true, entries: [{ path: 'docs/a.md', collapsedDirectory: false }] },
    });
  });
});
