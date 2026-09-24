import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test, { after as afterAll, describe } from 'node:test';

import { Effect } from 'effect';

import { GitCommandError, type GitService } from '../../git/index.js';
import { createFixtureWorkspace } from '../../git/tests/fixtures.js';
import { DetachedWorktreeError } from '../detached-worktree.js';
import { WorkspaceRepository, type WorkspaceRepositoryService } from '../workspace.repository.js';
import { WorkspaceService } from '../workspace.service.js';
import { createGitProjectFixture, withRegisteredGitProject } from './live-git-support.js';
import { type LiveWorkspaceOptions, runWithLiveWorkspace } from './live-workspace-support.js';

/**
 * Detached creation against real Git, a real database and the real service.
 *
 * The recorder arms only after registration, so everything it records belongs to the call under
 * test. A refused request must record nothing: no repository write, no prune cleanup, and no Git
 * command beyond the two read-only probes.
 */

const fixture = createGitProjectFixture('worktree-detached');
// Deliberately not canonicalized: on macOS `os.tmpdir()` is behind a symlink, so every destination
// here exercises the case the canonicalization exists for.
const destinations = mkdtempSync(join(tmpdir(), 'isagi-detached-dest-'));
afterAll(() => {
  fixture.cleanup();
  rmSync(destinations, { recursive: true, force: true });
});

let destinationCounter = 0;
function freshDestination(...segments: string[]) {
  destinationCounter += 1;
  return join(destinations, `d${destinationCounter}`, ...segments);
}

const writeMethods = [
  'createProject',
  'deleteProject',
  'deleteWorktree',
  'moveProjectOrder',
  'moveProjectWorktreeOrder',
  'reconcileProjectWorktrees',
  'restoreProjectAtRootPath',
  'setProjectStatus',
] as const satisfies readonly (keyof WorkspaceRepositoryService)[];

type GitOverride = (
  args: readonly string[],
  inner: GitService,
) => ReturnType<GitService['run']> | undefined;

function recorder(
  input: {
    readonly git?: GitOverride;
    readonly repository?: Partial<
      Record<(typeof writeMethods)[number], () => Effect.Effect<never, unknown>>
    >;
  } = {},
) {
  const state = {
    armed: false,
    writes: [] as string[],
    gitCalls: [] as (readonly string[])[],
    prunes: 0,
  };
  const options = {
    decorateRepository: (inner) => {
      const decorated: Record<string, unknown> = { ...inner };
      for (const name of writeMethods) {
        const original = inner[name] as (...args: never[]) => unknown;
        decorated[name] = (...args: never[]) => {
          if (!state.armed) return original(...args);
          state.writes.push(name);
          return input.repository?.[name]?.() ?? original(...args);
        };
      }
      return decorated as unknown as WorkspaceRepositoryService;
    },
    decorateGit: (inner) => ({
      run: (args, runOptions) => {
        if (!state.armed) return inner.run(args, runOptions);
        state.gitCalls.push(args);
        return input.git?.(args, inner) ?? inner.run(args, runOptions);
      },
    }),
    commands: {
      cleanupBeforeWorktreePrune: () =>
        Effect.sync(() => {
          if (state.armed) state.prunes += 1;
        }),
    },
    // Any consultation of setup trust or setup runs is a regression: detached creation has none.
    worktreeSetup: {
      preflight: () => Effect.die('setup preflight must not run'),
      updateTrust: () => Effect.die('setup trust must not change'),
      validateTrustForOpen: () => Effect.die('setup trust must not be validated'),
    },
    worktreeSetupRepository: {
      findTrust: () => Effect.die('setup trust must not be read'),
      setTrustedHash: () => Effect.die('setup trust must not be written'),
      disableHooks: () => Effect.die('setup hooks must not change'),
      createRunWithSteps: () => Effect.die('setup must not run'),
      listRunSteps: () => Effect.die('setup runs must not be read'),
    },
  } satisfies LiveWorkspaceOptions;
  return { state, options, arm: Effect.sync(() => void (state.armed = true)) };
}

const isWorktreeAdd = (args: readonly string[]) =>
  args.includes('worktree') && args.includes('add');

function assertNothingWritten(state: ReturnType<typeof recorder>['state']) {
  assert.deepEqual(state.writes, [], 'a refused request wrote to the repository');
  assert.equal(state.prunes, 0, 'a refused request ran prune cleanup');
  assert.equal(state.gitCalls.some(isWorktreeAdd), false, 'a refused request ran worktree add');
}

function expectDetached(error: unknown): DetachedWorktreeError {
  assert.ok(
    error instanceof DetachedWorktreeError,
    `expected DetachedWorktreeError, got ${String(error)}`,
  );
  return error;
}

const branches = (git: (args: readonly string[]) => string) =>
  git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);

/** Registers the shared fixture, arms the recorder, and runs one detached creation. */
function createAgainstFixture(
  label: string,
  rec: ReturnType<typeof recorder>,
  input: (projectId: number) => { readonly commit?: string; readonly path: string },
) {
  return withRegisteredGitProject(label, fixture.rootPath, rec.options, (projectId) =>
    Effect.gen(function* () {
      const service = yield* WorkspaceService;
      const repository = yield* WorkspaceRepository;
      const request = input(projectId);
      yield* rec.arm;
      const result = yield* service
        .createDetachedWorktree({
          projectId,
          commit: request.commit ?? fixture.head(),
          path: request.path,
        })
        .pipe(Effect.either);
      return { projectId, result, worktrees: yield* repository.listWorktrees };
    }),
  );
}

describe('creating a detached worktree', () => {
  test('at an absent path: the row is detached, canonical, at the commit, with no setup', async () => {
    const commit = fixture.head();
    const before = branches(fixture.git);
    const rec = recorder();
    const destination = freshDestination('nested', 'absent');

    const { result, worktrees } = await createAgainstFixture('detached-absent', rec, () => ({
      path: destination,
    }));

    assert.equal(result._tag, 'Right');
    const created = result.right;
    const canonical = join(
      realpathSync.native(destinations),
      destination.slice(destinations.length + 1),
    );
    assert.equal(created.path, canonical);
    assert.equal(created.head, commit);
    const row = worktrees.find((worktree) => worktree.id === created.worktreeId);
    assert.equal(row?.branch, null);
    assert.equal(row?.path, canonical);
    assert.ok(readdirSync(canonical).length > 0);
    assert.equal(fixture.git(['-C', canonical, 'rev-parse', 'HEAD']).trim(), commit);
    // No branch created or moved.
    assert.equal(branches(fixture.git), before);
    assert.equal(rec.state.gitCalls.filter(isWorktreeAdd).length, 1);
    assert.ok(
      rec.state.gitCalls.find(isWorktreeAdd)?.includes('--detach'),
      'worktree add must be detached',
    );
  });

  test('at an existing empty directory', async () => {
    const rec = recorder();
    const destination = freshDestination('empty');
    mkdirSync(destination, { recursive: true });

    const { result } = await createAgainstFixture('detached-empty', rec, () => ({
      path: destination,
    }));

    assert.equal(result._tag, 'Right');
    assert.equal(result.right.path, realpathSync.native(destination));
  });

  test('the macOS /tmp spelling is registered as Git reports it', async (t) => {
    const destination = join(tmpdir(), `isagi-detached-tmp-${process.pid}-${Date.now()}`);
    if (realpathSync.native(tmpdir()) === tmpdir()) {
      t.diagnostic('tmpdir is not behind a symlink here; the canonical spelling equals the input');
    }
    const rec = recorder();
    try {
      const { result, worktrees } = await createAgainstFixture('detached-tmp', rec, () => ({
        path: destination,
      }));
      assert.equal(result._tag, 'Right');
      const expected = join(realpathSync.native(tmpdir()), destination.slice(tmpdir().length + 1));
      assert.equal(result.right.path, expected);
      assert.equal(worktrees.find((row) => row.id === result.right.worktreeId)?.path, expected);
    } finally {
      rmSync(destination, { recursive: true, force: true });
    }
  });
});

describe('a refused destination is refused before any Git mutation and writes nothing', () => {
  const cases: readonly {
    readonly name: string;
    readonly issue: string;
    readonly prepare: () => string;
  }[] = [
    { name: 'a relative path', issue: 'not_absolute', prepare: () => 'relative/destination' },
    {
      name: 'a non-empty directory',
      issue: 'not_empty',
      prepare: () => {
        const path = freshDestination('full');
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, 'keep.txt'), 'x');
        return path;
      },
    },
    {
      name: 'a file',
      issue: 'not_directory',
      prepare: () => {
        const path = freshDestination('file');
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, 'x');
        return path;
      },
    },
    {
      name: 'a symlink to an empty directory, which is refused rather than followed',
      issue: 'not_directory',
      prepare: () => {
        const target = freshDestination('target');
        mkdirSync(target, { recursive: true });
        const link = freshDestination('link');
        mkdirSync(join(link, '..'), { recursive: true });
        symlinkSync(target, link);
        return link;
      },
    },
  ];

  for (const entry of cases) {
    test(`${entry.name} is ${entry.issue}`, async () => {
      const rec = recorder();
      const path = entry.prepare();
      const { result } = await createAgainstFixture(`detached-${entry.issue}`, rec, () => ({
        path,
      }));
      assert.equal(result._tag, 'Left');
      const error = expectDetached(result.left);
      assert.equal(error.reason, 'destination_rejected');
      assert.equal(error.destinationIssue, entry.issue);
      assertNothingWritten(rec.state);
    });
  }

  test('a path that cannot be inspected is inaccessible', async (t) => {
    if (process.getuid?.() === 0) {
      t.skip('root ignores directory permissions');
      return;
    }
    const locked = freshDestination('locked');
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o000);
    try {
      const rec = recorder();
      const { result } = await createAgainstFixture('detached-inaccessible', rec, () => ({
        path: join(locked, 'inside'),
      }));
      const error = expectDetached(result._tag === 'Left' ? result.left : null);
      assert.equal(error.destinationIssue, 'inaccessible');
      assertNothingWritten(rec.state);
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});

describe('a destination inside a checkout is inside_checkout', () => {
  test('inside the project root, naming the root worktree', async () => {
    const rec = recorder();
    const { result, worktrees, projectId } = await createAgainstFixture(
      'detached-in-root',
      rec,
      () => ({ path: join(fixture.rootPath, 'nested', 'export') }),
    );
    const error = expectDetached(result._tag === 'Left' ? result.left : null);
    assert.equal(error.destinationIssue, 'inside_checkout');
    const root = worktrees.find(
      (row) => row.projectId === projectId && row.path === realpathSync.native(fixture.rootPath),
    );
    assert.equal(error.containingWorktreeId, root?.id);
    assertNothingWritten(rec.state);
    assert.equal(existsSync(join(fixture.rootPath, 'nested')), false);
  });

  test('inside a reconciled linked worktree, naming it', async () => {
    const linked = join(fixture.workspace.root, 'linked-reconciled');
    fixture.git(['worktree', 'add', '--detach', linked, 'HEAD']);
    const rec = recorder();
    const { result, worktrees } = await createAgainstFixture('detached-in-linked', rec, () => ({
      path: join(linked, 'export'),
    }));
    const error = expectDetached(result._tag === 'Left' ? result.left : null);
    assert.equal(error.destinationIssue, 'inside_checkout');
    assert.equal(error.containingWorktreeId, worktrees.find((row) => row.path === linked)?.id);
    assertNothingWritten(rec.state);
  });

  test('inside a worktree Git lists but Isagi has not reconciled', async () => {
    const rec = recorder();
    const linked = join(fixture.workspace.root, 'linked-unreconciled');
    const { result } = await createAgainstFixture('detached-in-unreconciled', rec, () => {
      // Added after registration, so no row exists for it.
      fixture.git(['worktree', 'add', '--detach', linked, 'HEAD']);
      return { path: join(linked, 'export') };
    });
    const error = expectDetached(result._tag === 'Left' ? result.left : null);
    assert.equal(error.destinationIssue, 'inside_checkout');
    assert.equal(error.containingWorktreeId, undefined);
    assertNothingWritten(rec.state);
  });

  test('at a prunable worktree Git still lists, whose folder is gone', async () => {
    const rec = recorder();
    const linked = join(fixture.workspace.root, 'linked-prunable');
    const { result } = await createAgainstFixture('detached-prunable', rec, () => {
      fixture.git(['worktree', 'add', '--detach', linked, 'HEAD']);
      rmSync(linked, { recursive: true, force: true });
      return { path: linked };
    });
    const error = expectDetached(result._tag === 'Left' ? result.left : null);
    assert.equal(error.destinationIssue, 'inside_checkout');
    assertNothingWritten(rec.state);
  });

  test('typed in a different letter case on a case-insensitive disk', async (t) => {
    const linked = join(fixture.workspace.root, 'CaseLinked');
    fixture.git(['worktree', 'add', '--detach', linked, 'HEAD']);
    const typed = join(fixture.workspace.root, 'caselinked');
    if (!existsSync(typed)) {
      t.skip('the temporary filesystem is case-sensitive');
      return;
    }
    const rec = recorder();
    const { result } = await createAgainstFixture('detached-case', rec, () => ({
      path: join(typed, 'export'),
    }));
    const error = expectDetached(result._tag === 'Left' ? result.left : null);
    assert.equal(error.destinationIssue, 'inside_checkout');
    assertNothingWritten(rec.state);
  });
});

describe('an unusable repository is project_unavailable and leaves its row alone', () => {
  test('an unknown project', async () => {
    const rec = recorder();
    const error = await runWithLiveWorkspace(
      'detached-unknown-project',
      rec.options,
      Effect.gen(function* () {
        yield* rec.arm;
        return yield* (yield* WorkspaceService)
          .createDetachedWorktree({
            projectId: 999,
            commit: fixture.head(),
            path: freshDestination(),
          })
          .pipe(Effect.flip);
      }),
    );
    assert.equal(expectDetached(error).reason, 'project_unavailable');
    assertNothingWritten(rec.state);
  });

  test('a folder project', async () => {
    const workspace = createFixtureWorkspace('detached-folder');
    try {
      const folder = workspace.directory('plain');
      writeFileSync(join(folder, 'notes.md'), '# notes\n');
      const rec = recorder();
      const error = await runWithLiveWorkspace(
        'detached-folder',
        rec.options,
        Effect.gen(function* () {
          const service = yield* WorkspaceService;
          const { projectId } = yield* service.registerProject({ path: folder });
          yield* rec.arm;
          return yield* service
            .createDetachedWorktree({ projectId, commit: fixture.head(), path: freshDestination() })
            .pipe(Effect.flip);
        }),
      );
      assert.equal(expectDetached(error).reason, 'project_unavailable');
      assertNothingWritten(rec.state);
    } finally {
      workspace.cleanup();
    }
  });

  test('a project already marked missing', async () => {
    const rec = recorder();
    const error = await withRegisteredGitProject(
      'detached-missing',
      fixture.rootPath,
      rec.options,
      (projectId) =>
        Effect.gen(function* () {
          yield* (yield* WorkspaceRepository).setProjectStatus({
            id: projectId,
            status: 'missing',
            missingReason: 'test',
          });
          yield* rec.arm;
          return yield* (yield* WorkspaceService)
            .createDetachedWorktree({ projectId, commit: fixture.head(), path: freshDestination() })
            .pipe(Effect.flip);
        }),
    );
    assert.equal(expectDetached(error).reason, 'project_unavailable');
    assertNothingWritten(rec.state);
  });

  for (const scenario of [
    {
      name: 'a root folder that is gone',
      break: (root: string) => rmSync(root, { recursive: true, force: true }),
    },
    {
      name: 'a .git that is gone while the folder remains (Git exits 128)',
      break: (root: string) => rmSync(join(root, '.git'), { recursive: true, force: true }),
    },
  ]) {
    test(`${scenario.name}, with the present status row untouched`, async () => {
      const own = createGitProjectFixture('detached-broken');
      try {
        const rec = recorder();
        const outcome = await withRegisteredGitProject(
          'detached-broken',
          own.rootPath,
          rec.options,
          (projectId) =>
            Effect.gen(function* () {
              const commit = own.head();
              scenario.break(own.rootPath);
              yield* rec.arm;
              const error = yield* (yield* WorkspaceService)
                .createDetachedWorktree({ projectId, commit, path: freshDestination() })
                .pipe(Effect.flip);
              return { error, project: yield* (yield* WorkspaceRepository).findProject(projectId) };
            }),
        );
        assert.equal(expectDetached(outcome.error).reason, 'project_unavailable');
        assert.equal(outcome.project?.status, 'present');
        assertNothingWritten(rec.state);
      } finally {
        own.cleanup();
      }
    });
  }

  test('a Git that could not run is a GitCommandError, not project_unavailable', async () => {
    const rec = recorder({
      git: (args) =>
        args.includes('list')
          ? Effect.fail(
              new GitCommandError({
                args,
                cause: new Error('spawn git ENOENT'),
                cwd: undefined,
                failure: { kind: 'spawn_failed', systemErrorCode: 'ENOENT' },
                stderr: '',
              }),
            )
          : undefined,
    });
    const { result } = await createAgainstFixture('detached-spawn', rec, () => ({
      path: freshDestination(),
    }));
    assert.ok(result._tag === 'Left' && result.left instanceof GitCommandError);
    assertNothingWritten(rec.state);
  });
});

describe('the commit probe', () => {
  for (const commit of ['0'.repeat(40), '0'.repeat(64)]) {
    test(`an absent ${commit.length}-hex commit is commit_not_found`, async () => {
      const rec = recorder();
      const { result } = await createAgainstFixture(
        `detached-absent-${commit.length}`,
        rec,
        () => ({
          commit,
          path: freshDestination(),
        }),
      );
      const error = expectDetached(result._tag === 'Left' ? result.left : null);
      assert.equal(error.reason, 'commit_not_found');
      assertNothingWritten(rec.state);
    });
  }

  test('a probe that exits 128 is a GitCommandError, never a missing commit', async () => {
    const rec = recorder({
      git: (args) =>
        args.includes('rev-parse')
          ? Effect.fail(
              new GitCommandError({
                args,
                cause: new Error('fatal'),
                cwd: undefined,
                failure: { kind: 'exited', exitCode: 128 },
                stderr: 'fatal: bad object',
              }),
            )
          : undefined,
    });
    const { result } = await createAgainstFixture('detached-probe-128', rec, () => ({
      path: freshDestination(),
    }));
    assert.ok(result._tag === 'Left' && result.left instanceof GitCommandError);
    assertNothingWritten(rec.state);
  });

  test('a SHA-256 repository creates at its 64-hex commit', async (t) => {
    const workspace = createFixtureWorkspace('detached-sha256');
    try {
      const root = workspace.directory('project');
      try {
        workspace.git(root, ['init', '--object-format=sha256']);
      } catch {
        t.skip('this Git cannot create a SHA-256 repository');
        return;
      }
      writeFileSync(join(root, 'README.md'), '# sha256\n');
      workspace.git(root, ['add', '.']);
      workspace.git(root, ['commit', '-m', 'initial']);
      const commit = workspace.git(root, ['rev-parse', 'HEAD']).trim();
      assert.equal(commit.length, 64);

      const destination = freshDestination('sha256');
      const created = await withRegisteredGitProject(
        'detached-sha256',
        root,
        recorder().options,
        (projectId) =>
          Effect.flatMap(WorkspaceService, (service) =>
            service.createDetachedWorktree({ projectId, commit, path: destination }),
          ),
      );
      assert.equal(created.head, commit);
      assert.equal(created.path, realpathSync.native(destination));
    } finally {
      workspace.cleanup();
    }
  });
});

describe('a failure after the checks is reported with what is on disk', () => {
  test('a failed worktree add that left nothing is git_add_failed, created false', async () => {
    const rec = recorder({
      git: (args) =>
        isWorktreeAdd(args)
          ? Effect.fail(
              new GitCommandError({
                args,
                cause: new Error('fatal'),
                cwd: undefined,
                failure: { kind: 'exited', exitCode: 128 },
                stderr: 'fatal: injected',
              }),
            )
          : undefined,
    });
    const { result } = await createAgainstFixture('detached-add-empty', rec, () => ({
      path: freshDestination('add-failed'),
    }));
    const error = expectDetached(result._tag === 'Left' ? result.left : null);
    assert.equal(error.reason, 'git_add_failed');
    assert.equal(error.created, false);
    assert.deepEqual(rec.state.writes, []);
  });

  test('a worktree add that failed after checking out is git_add_failed, created true', async () => {
    const rec = recorder({
      git: (args, inner) =>
        isWorktreeAdd(args)
          ? inner.run(args).pipe(
              Effect.zipRight(
                Effect.fail(
                  new GitCommandError({
                    args,
                    cause: new Error('hook failed'),
                    cwd: undefined,
                    failure: { kind: 'exited', exitCode: 1 },
                    stderr: 'post-checkout hook failed',
                  }),
                ),
              ),
            )
          : undefined,
    });
    const { result } = await createAgainstFixture('detached-add-created', rec, () => ({
      path: freshDestination('add-created'),
    }));
    const error = expectDetached(result._tag === 'Left' ? result.left : null);
    assert.equal(error.reason, 'git_add_failed');
    assert.equal(error.created, true);
  });

  test('a failed post-add reconcile is registration_failed, created true', async () => {
    const rec = recorder({
      repository: {
        reconcileProjectWorktrees: () => Effect.fail(new Error('injected reconcile failure')),
      },
    });
    const { result } = await createAgainstFixture('detached-register', rec, () => ({
      path: freshDestination('register-failed'),
    }));
    const error = expectDetached(result._tag === 'Left' ? result.left : null);
    assert.equal(error.reason, 'registration_failed');
    assert.equal(error.created, true);
  });
});
