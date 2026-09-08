import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { Cause, Effect, Exit, Layer, Option } from 'effect';

import { Git, GitLive } from './git.command.js';
import {
  classifyProjectRoot,
  normalizeExistingDirectory,
  ProjectPathValidationError,
  validateProjectRoot,
  type ProjectPathValidationCode,
  type ProjectRootClassification,
} from './project-root.js';
import { createFixtureWorkspace, type FixtureWorkspace } from './tests/fixtures.js';

/**
 * Real layouts built by real `git`, because the property under test is what Git
 * actually answers — a double would only re-state this file's own assumptions.
 *
 * The guarantee these tests establish, stated no wider than it is: no layout
 * carrying a `.git` marker at or above the path is ever classified as a folder,
 * and bare-directory debris is refused down to the two-of-three threshold in
 * `git-metadata.ts`. Below that threshold a stripped bare directory is
 * byte-identical to an ordinary folder and does classify as a folder; that is a
 * stated design floor, asserted here so it stays a decision rather than drift.
 */

let workspace: FixtureWorkspace;

before(() => {
  workspace = createFixtureWorkspace('classification');
});

after(() => {
  workspace.cleanup();
});

/** Proves path rejection happens before any subprocess, not merely ahead of a verdict. */
const refuseToRunGit = Layer.succeed(Git, {
  run: (args) =>
    Effect.die(new Error(`git must not run for a rejected path: git ${args.join(' ')}`)),
});

async function classify(path: string) {
  const root = await Effect.runPromise(normalizeExistingDirectory(path));
  return Effect.runPromiseExit(classifyProjectRoot(root).pipe(Effect.provide(GitLive)));
}

async function expectKind(path: string, kind: ProjectRootClassification['kind']) {
  const exit = await classify(path);
  assert.ok(
    Exit.isSuccess(exit),
    `expected ${path} to classify as ${kind}, but it failed with ${String(exit)}`,
  );
  assert.equal(exit.value.kind, kind);
  assert.equal(exit.value.rootPath, path);
  return exit.value;
}

async function expectRejection(path: string, code: ProjectPathValidationCode) {
  const exit = await classify(path);
  assert.ok(Exit.isFailure(exit), `expected ${path} to be refused, but it classified successfully`);
  const failure = typedFailure(exit);
  assert.equal(failure.code, code, `unexpected rejection for ${path}: ${failure.message}`);
  return failure;
}

function typedFailure(exit: Exit.Exit<unknown, ProjectPathValidationError>) {
  assert.ok(Exit.isFailure(exit));
  const failure = Option.getOrNull(Cause.failureOption(exit.cause));
  assert.ok(
    failure instanceof ProjectPathValidationError,
    `expected a typed ProjectPathValidationError, got ${String(exit.cause)}`,
  );
  return failure;
}

describe('supported layouts', () => {
  test('an ordinary directory is a folder, and that is the only success path to it', async () => {
    const path = workspace.directory('ordinary');
    const classification = await expectKind(path, 'folder');
    assert.equal(classification.name, 'ordinary');
  });

  test('a git init root is a git project', async () => {
    const path = workspace.directory('main-checkout');
    workspace.git(path, ['init']);
    await expectKind(path, 'git');
  });

  test('a subdirectory of a repository is refused as not the root', async () => {
    const path = workspace.directory('root-with-child');
    workspace.git(path, ['init']);
    const child = join(path, 'nested');
    mkdirSync(child);
    await expectRejection(child, 'not_repository_root');
  });

  test('a bare repository is refused for having no working tree', async () => {
    const path = workspace.directory('bare');
    workspace.git(path, ['init', '--bare']);
    await expectRejection(path, 'bare_repository');
  });

  test('a directory inside a valid bare repository is refused at the first probe', async () => {
    const path = workspace.directory('bare-with-child');
    workspace.git(path, ['init', '--bare']);
    // `--is-bare-repository` answers `true` here, so corroboration is never
    // reached: the negative-answer branch is not the only thing standing
    // between a Git layout and a folder verdict.
    await expectRejection(join(path, 'refs'), 'bare_repository');
  });

  test('a linked worktree checkout is refused in favour of the main checkout', async () => {
    const main = workspace.directory('worktree-main');
    workspace.git(main, ['init']);
    writeFileSync(join(main, 'file.txt'), 'contents\n');
    workspace.git(main, ['add', 'file.txt']);
    workspace.git(main, ['commit', '-m', 'initial']);
    const linked = join(workspace.root, 'worktree-linked');
    workspace.git(main, ['worktree', 'add', linked, '-b', 'feature']);
    await expectRejection(linked, 'linked_worktree_checkout');
  });

  test('a separate git directory checkout is refused', async () => {
    const path = workspace.directory('separate-git-dir');
    const elsewhere = join(workspace.root, 'separate-git-dir-store');
    workspace.git(path, ['init', `--separate-git-dir=${elsewhere}`]);
    await expectRejection(path, 'linked_worktree_checkout');
  });
});

describe('malformed metadata never becomes a folder', () => {
  test('an empty .git directory', async () => {
    const path = workspace.directory('empty-dot-git');
    mkdirSync(join(path, '.git'));
    await expectRejection(path, 'git_metadata_unreadable');
  });

  test('a repository whose .git/HEAD is broken', async () => {
    const path = workspace.directory('broken-head');
    workspace.git(path, ['init']);
    writeFileSync(join(path, '.git', 'HEAD'), 'broken\n');
    await expectRejection(path, 'git_metadata_unreadable');
  });

  test('a .git file naming a gitdir that does not exist', async () => {
    const path = workspace.directory('dangling-gitdir-file');
    writeFileSync(join(path, '.git'), `gitdir: ${join(workspace.root, 'no-such-git-dir')}\n`);
    await expectRejection(path, 'git_metadata_unreadable');
  });

  test('a .git symlink whose target does not exist', async () => {
    const path = workspace.directory('dangling-gitdir-symlink');
    // The case a naive `existsSync` reports as absent, because it follows the link.
    symlinkSync(join(workspace.root, 'no-such-target'), join(path, '.git'));
    await expectRejection(path, 'git_metadata_unreadable');
  });

  test('a bare repository whose HEAD is broken', async () => {
    const path = workspace.directory('bare-broken-head');
    workspace.git(path, ['init', '--bare']);
    writeFileSync(join(path, 'HEAD'), 'broken\n');
    await expectRejection(path, 'git_metadata_unreadable');
  });

  for (const entry of ['HEAD', 'objects', 'refs'] as const) {
    test(`a bare repository with ${entry} deleted still has two signature entries`, async () => {
      const path = workspace.directory(`bare-without-${entry}`);
      workspace.git(path, ['init', '--bare']);
      rmSync(join(path, entry), { recursive: true, force: true });
      await expectRejection(path, 'git_metadata_unreadable');
    });
  }

  test('an ordinary child beneath a broken .git in an ancestor', async () => {
    const parent = workspace.directory('broken-ancestor');
    mkdirSync(join(parent, '.git'));
    const child = join(parent, 'child');
    mkdirSync(child);
    const failure = await expectRejection(child, 'git_metadata_unreadable');
    assert.match(failure.message, /broken-ancestor/);
  });

  test('an ordinary child beneath recognizable broken bare metadata', async () => {
    const parent = workspace.directory('broken-bare-ancestor');
    workspace.git(parent, ['init', '--bare']);
    writeFileSync(join(parent, 'HEAD'), 'broken\n');
    const child = join(parent, 'child');
    mkdirSync(child);
    await expectRejection(child, 'git_metadata_unreadable');
  });
});

describe('the accepted detection floor', () => {
  test('two ordinary signature names are refused, the false positive the threshold buys', async () => {
    const path = workspace.directory('objects-and-refs');
    mkdirSync(join(path, 'objects'));
    mkdirSync(join(path, 'refs'));
    await expectRejection(path, 'git_metadata_unreadable');
  });

  test('a lone objects directory is not enough to refuse an ordinary folder', async () => {
    const path = workspace.directory('objects-only');
    mkdirSync(join(path, 'objects'));
    await expectKind(path, 'folder');
  });

  test('a bare directory stripped past the threshold does classify as a folder', async () => {
    // Deliberate and stated (program design §4.3, "Where the floor is"): with
    // only one signature entry left the directory is indistinguishable from an
    // ordinary folder, and widening the signature would refuse real folders.
    // The residue is tolerable because repairing bare debris yields a bare
    // repository, which is refused anyway — so no reachable Git project is lost.
    const path = workspace.directory('bare-below-threshold');
    workspace.git(path, ['init', '--bare']);
    rmSync(join(path, 'HEAD'), { force: true });
    rmSync(join(path, 'objects'), { recursive: true, force: true });
    await expectKind(path, 'folder');
  });
});

describe('validateProjectRoot stays Git-only', () => {
  test('an ordinary folder is refused as not a Git repository', async () => {
    const path = workspace.directory('wrapper-ordinary');
    const exit = await Effect.runPromiseExit(
      validateProjectRoot(path).pipe(Effect.provide(GitLive)),
    );
    assert.equal(typedFailure(exit).code, 'not_git_repository');
  });

  test('a Git root passes through with its canonical path and name', async () => {
    const path = workspace.directory('wrapper-repository');
    workspace.git(path, ['init']);
    const root = await Effect.runPromise(validateProjectRoot(path).pipe(Effect.provide(GitLive)));
    assert.deepEqual(root, { rootPath: path, name: 'wrapper-repository' });
  });
});

describe('normalizeExistingDirectory rejects unusable paths before any Git work', () => {
  test('a path that does not exist', async () => {
    const missing = join(workspace.root, 'no-such-directory');
    const exit = await Effect.runPromiseExit(normalizeExistingDirectory(missing));
    assert.equal(typedFailure(exit).code, 'path_not_found');
  });

  test('a regular file is not a project root', async () => {
    const file = join(workspace.root, 'a-file.txt');
    writeFileSync(file, 'not a directory\n');
    const exit = await Effect.runPromiseExit(normalizeExistingDirectory(file));
    assert.equal(typedFailure(exit).code, 'not_directory');
  });

  test('an unreadable path reports path_not_found, not permission_denied', async (t) => {
    // Pinning behavior that is easy to misread as a bug in the extraction, and
    // is neither: `validateDirectory` was carried over verbatim, and its
    // `existsSync` guard runs first. `existsSync` swallows EACCES and answers
    // `false`, so a genuine permission failure is reported as a missing path and
    // the `permission_denied` branch below it is unreachable except through a
    // race. Recorded in decisions.md rather than changed here, because the
    // reviewed design specifies this helper as behaviorally unchanged.
    const parent = join(workspace.root, 'unreadable-input');
    const candidate = join(parent, 'child');
    mkdirSync(candidate, { recursive: true });
    try {
      chmodSync(parent, 0o000);
      let denied = false;
      try {
        statSync(candidate);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        denied = code === 'EACCES' || code === 'EPERM';
      }
      if (!denied) {
        t.skip('permission denial could not be reproduced on this platform or as this user');
        return;
      }
      const exit = await Effect.runPromiseExit(normalizeExistingDirectory(candidate));
      assert.equal(typedFailure(exit).code, 'path_not_found');
    } finally {
      chmodSync(parent, 0o700);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('a rejected path never reaches a Git probe', async () => {
    const missing = join(workspace.root, 'never-probed');
    const exit = await Effect.runPromiseExit(
      validateProjectRoot(missing).pipe(Effect.provide(refuseToRunGit)),
    );
    assert.equal(typedFailure(exit).code, 'path_not_found');
  });
});

/**
 * Classifier-level `git_metadata_indeterminate` has no deterministic real-
 * filesystem construction, and the reason is structural rather than a gap in
 * effort. Every `lstat` the ancestor walk performs targets an entry inside a
 * directory that had to be traversable for the candidate path to be reached and
 * stat'd in the first place, so an ancestor made unreadable does not produce an
 * indeterminate walk — it makes the candidate unreachable, and `git -C` fails to
 * change directory long before corroboration is consulted. No suitable
 * deterministic real-filesystem construction was identified within scope.
 *
 * The behavior is therefore evidenced in layers, and this file deliberately
 * carries none of it: `git-metadata.test.ts` proves the walk's errno handling
 * against both an injected `lstat` and one real EACCES, and
 * `project-root.failures.test.ts` proves the classifier refuses rather than
 * guesses for every failure shape it can be handed.
 */
