import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { after as afterAll, describe } from 'node:test';

import { Effect } from 'effect';

import { branchPathHash } from '../../git/index.js';
import { createFixtureWorkspace } from '../../git/tests/fixtures.js';
import { WorkspaceRepository } from '../workspace.repository.js';
import { WorkspaceError, WorkspaceService } from '../workspace.service.js';
import { createGitProjectFixture, withRegisteredGitProject } from './live-git-support.js';
import type { LiveWorkspaceOptions } from './live-workspace-support.js';

/**
 * These exercise the owner-side operations the workflow engine composes, against real Git.
 *
 * Everything asserted here is a fact only Git holds — which branches exist, what a ref resolves to,
 * which commit a new checkout starts from — so a stubbed `GitService` would answer them by
 * restating the assumption under test. `service.worktree-new-branch.test.ts` keeps the stubbed
 * cases, where the point is which Git commands the service chooses to run.
 */

const fixture = createGitProjectFixture('worktree-creation');
afterAll(() => {
  fixture.cleanup();
});

/** Post-create commands run on every successful creation; the live harness otherwise dies on them. */
const countingCommands = () => {
  const worktreeIds: number[] = [];
  const options = {
    commands: {
      runPostCreateLifecycle: (input: { readonly worktreeId: number }) =>
        Effect.sync(() => {
          worktreeIds.push(input.worktreeId);
        }),
    },
  } satisfies LiveWorkspaceOptions;
  return { options, worktreeIds };
};

function expectWorkspaceError(error: unknown): WorkspaceError {
  assert.ok(error instanceof WorkspaceError, `expected a WorkspaceError, got ${String(error)}`);
  return error;
}

describe('preflightWorktreeCreation', () => {
  test('resolves the base ref to a commit and derives the checkout path, allocating nothing', async () => {
    const branch = 'feature/preflight-ok';
    const head = fixture.head();

    const result = await withRegisteredGitProject(
      'preflight-ok',
      fixture.rootPath,
      {},
      (projectId) =>
        Effect.gen(function* () {
          const service = yield* WorkspaceService;
          const repository = yield* WorkspaceRepository;
          const preflight = yield* service.preflightWorktreeCreation({
            projectId,
            branch,
            fromRef: 'main',
          });
          return {
            preflight,
            projectId,
            // Nothing may have been created: the preflight's whole purpose is to answer before
            // anything is allocated.
            worktrees: (yield* repository.listWorktrees).length,
          };
        }),
    );

    assert.match(result.preflight.commit, /^[0-9a-f]{40}$/);
    assert.equal(result.preflight.commit, head);
    assert.equal(result.worktrees, 1);
    assert.ok(result.preflight.checkoutPath.endsWith(branchPathHash(branch)));
    assert.equal(existsSync(result.preflight.checkoutPath), false);
  });

  test('an unknown base ref is base_ref_not_found', async () => {
    const error = await withRegisteredGitProject(
      'preflight-missing-ref',
      fixture.rootPath,
      {},
      (projectId) =>
        Effect.gen(function* () {
          const service = yield* WorkspaceService;
          return yield* service.preflightWorktreeCreation({
            projectId,
            branch: 'feature/missing-ref',
            fromRef: 'no/such/ref',
          });
        }).pipe(Effect.flip),
    );

    assert.equal(expectWorkspaceError(error).code, 'base_ref_not_found');
    assert.equal(expectWorkspaceError(error).branch, 'no/such/ref');
  });

  test('an invalid branch name is refused by Git, not by hand-written parsing', async () => {
    const error = await withRegisteredGitProject(
      'preflight-bad-branch',
      fixture.rootPath,
      {},
      (projectId) =>
        Effect.gen(function* () {
          const service = yield* WorkspaceService;
          return yield* service.preflightWorktreeCreation({
            projectId,
            branch: 'feature/..bad',
            fromRef: 'main',
          });
        }).pipe(Effect.flip),
    );

    assert.equal(expectWorkspaceError(error).code, 'invalid_branch_name');
  });

  test('an existing local branch with no worktree is branch_exists', async () => {
    fixture.git(['branch', 'feature/already-a-branch']);

    const error = await withRegisteredGitProject(
      'preflight-branch-exists',
      fixture.rootPath,
      {},
      (projectId) =>
        Effect.gen(function* () {
          const service = yield* WorkspaceService;
          return yield* service.preflightWorktreeCreation({
            projectId,
            branch: 'feature/already-a-branch',
            fromRef: 'main',
          });
        }).pipe(Effect.flip),
    );

    assert.equal(expectWorkspaceError(error).code, 'branch_exists');
    assert.equal(expectWorkspaceError(error).branch, 'feature/already-a-branch');
  });

  test('a branch Isagi already has a worktree for is reported by the branch check, which runs first', async () => {
    const branch = 'feature/already-open';
    const commands = countingCommands();

    const error = await withRegisteredGitProject(
      'preflight-worktree-exists',
      fixture.rootPath,
      commands.options,
      (projectId) =>
        Effect.gen(function* () {
          const service = yield* WorkspaceService;
          const opened = yield* service.openWorktree({
            projectId,
            request: { branch, base: { kind: 'branch', ref: 'main' } },
          });
          assert.equal(opened.status, 'created');
          return yield* service
            .preflightWorktreeCreation({ projectId, branch, fromRef: 'main' })
            .pipe(Effect.flip);
        }),
    );

    // Creating a worktree creates its branch too, and the preflight consults Git's branch list
    // before Isagi's worktree rows, so this state is `branch_exists`. Pinned rather than left
    // implicit: the rejection a person reads for the commonest collision is decided here.
    assert.equal(expectWorkspaceError(error).code, 'branch_exists');
  });

  test('a worktree row whose branch Git no longer has is worktree_exists', async () => {
    const branch = 'feature/stale-row';
    const commands = countingCommands();

    const error = await withRegisteredGitProject(
      'preflight-stale-worktree-row',
      fixture.rootPath,
      commands.options,
      (projectId) =>
        Effect.gen(function* () {
          const service = yield* WorkspaceService;
          const opened = yield* service.openWorktree({
            projectId,
            request: { branch, base: { kind: 'branch', ref: 'main' } },
          });
          const created = yield* (yield* WorkspaceRepository).findProjectWorktreeByBranch({
            projectId,
            branch,
          });
          assert.ok(created);
          // Removed behind Isagi's back, which is the state the preflight is documented not to
          // reconcile away: the branch is gone from Git, the row is not.
          yield* Effect.sync(() => {
            fixture.git(['worktree', 'remove', '--force', created.path]);
            fixture.git(['branch', '-D', branch]);
          });
          assert.equal(opened.status, 'created');
          return yield* service
            .preflightWorktreeCreation({ projectId, branch, fromRef: 'main' })
            .pipe(Effect.flip);
        }),
    );

    const failure = expectWorkspaceError(error);
    assert.equal(failure.code, 'worktree_exists');
    assert.ok(failure.worktreeId);
    assert.ok(failure.path);
  });

  test('an occupied checkout path is checkout_path_exists', async () => {
    const branch = 'feature/path-taken';

    const error = await withRegisteredGitProject(
      'preflight-path-taken',
      fixture.rootPath,
      {},
      (projectId) =>
        Effect.gen(function* () {
          const service = yield* WorkspaceService;
          // Derived first through the service, so the test occupies exactly the path creation
          // would have used rather than a path it guessed.
          const preflight = yield* service.preflightWorktreeCreation({
            projectId,
            branch,
            fromRef: 'main',
          });
          mkdirSync(preflight.checkoutPath, { recursive: true });
          writeFileSync(join(preflight.checkoutPath, 'squatter.txt'), 'here first\n');
          return yield* service
            .preflightWorktreeCreation({ projectId, branch, fromRef: 'main' })
            .pipe(Effect.flip);
        }),
    );

    assert.equal(expectWorkspaceError(error).code, 'checkout_path_exists');
  });

  test('a folder project cannot create worktrees at all', async () => {
    const folderWorkspace = createFixtureWorkspace('preflight-folder');
    const folderPath = folderWorkspace.directory('plain');
    writeFileSync(join(folderPath, 'notes.md'), '# notes\n');

    try {
      const error = await withRegisteredGitProject(
        'preflight-folder',
        folderPath,
        {},
        (projectId) =>
          Effect.gen(function* () {
            const service = yield* WorkspaceService;
            return yield* service.preflightWorktreeCreation({
              projectId,
              branch: 'feature/anything',
              fromRef: 'main',
            });
          }).pipe(Effect.flip),
      );

      assert.equal(expectWorkspaceError(error).code, 'worktrees_not_supported');
    } finally {
      folderWorkspace.cleanup();
    }
  });
});

describe('openWorktree with a resolved commit base', () => {
  test('creates from the recorded commit even after the branch tip has moved', async () => {
    const branch = 'feature/from-commit';
    const commands = countingCommands();
    const baseCommit = fixture.head();

    const result = await withRegisteredGitProject(
      'open-from-commit',
      fixture.rootPath,
      commands.options,
      (projectId) =>
        Effect.gen(function* () {
          const service = yield* WorkspaceService;
          const repository = yield* WorkspaceRepository;
          // The decision was made against `baseCommit`; `main` moves before it is acted on. A
          // creation that re-resolved the ref here would silently branch from somewhere else.
          const movedTip = yield* Effect.sync(() => fixture.commit('moves the tip'));
          const opened = yield* service.openWorktree({
            projectId,
            request: { branch, base: { kind: 'commit', commit: baseCommit }, mode: 'create_new' },
          });
          const created = yield* repository.findProjectWorktreeByBranch({ projectId, branch });
          assert.ok(created);
          // Read here and not after the harness returns: the checkout lives under the data
          // directory `runWithLiveWorkspace` removes on the way out.
          const checkoutHead = yield* Effect.sync(() =>
            fixture.workspace.git(created.path, ['rev-parse', 'HEAD']).trim(),
          );
          return { opened, createdId: created.id, checkoutHead, movedTip };
        }),
    );

    assert.notEqual(result.movedTip, baseCommit);
    assert.equal(result.opened.status, 'created');
    assert.equal(result.checkoutHead, baseCommit);
    assert.deepEqual(commands.worktreeIds, [result.createdId]);
  });

  test('a commit that does not exist is base_ref_not_found', async () => {
    const error = await withRegisteredGitProject(
      'open-unknown-commit',
      fixture.rootPath,
      {},
      (projectId) =>
        Effect.gen(function* () {
          const service = yield* WorkspaceService;
          return yield* service.openWorktree({
            projectId,
            request: {
              branch: 'feature/unknown-commit',
              base: { kind: 'commit', commit: '0'.repeat(40) },
              mode: 'create_new',
            },
          });
        }).pipe(Effect.flip),
    );

    assert.equal(expectWorkspaceError(error).code, 'base_ref_not_found');
  });
});

describe('openWorktree mode', () => {
  test('create_new refuses a branch that already exists instead of checking it out', async () => {
    const branch = 'feature/create-new-branch-taken';
    fixture.git(['branch', branch]);

    const error = await withRegisteredGitProject(
      'open-create-new-branch',
      fixture.rootPath,
      {},
      (projectId) =>
        Effect.gen(function* () {
          const service = yield* WorkspaceService;
          return yield* service.openWorktree({
            projectId,
            request: {
              branch,
              base: { kind: 'commit', commit: fixture.head() },
              mode: 'create_new',
            },
          });
        }).pipe(Effect.flip),
    );

    assert.equal(expectWorkspaceError(error).code, 'branch_exists');
  });

  test('create_new refuses a branch Isagi already has a worktree for', async () => {
    const branch = 'feature/create-new-worktree-taken';
    const commands = countingCommands();

    const error = await withRegisteredGitProject(
      'open-create-new-worktree',
      fixture.rootPath,
      commands.options,
      (projectId) =>
        Effect.gen(function* () {
          const service = yield* WorkspaceService;
          const base = fixture.head();
          yield* service.openWorktree({
            projectId,
            request: { branch, base: { kind: 'commit', commit: base }, mode: 'create_new' },
          });
          return yield* service
            .openWorktree({
              projectId,
              request: { branch, base: { kind: 'commit', commit: base }, mode: 'create_new' },
            })
            .pipe(Effect.flip);
        }),
    );

    const failure = expectWorkspaceError(error);
    assert.equal(failure.code, 'worktree_exists');
    assert.ok(failure.worktreeId);
  });

  test('omitting mode preserves today’s adopt-and-return behaviour for the UI caller', async () => {
    const branch = 'feature/adopting-default';
    const commands = countingCommands();

    const result = await withRegisteredGitProject(
      'open-default-mode',
      fixture.rootPath,
      commands.options,
      (projectId) =>
        Effect.gen(function* () {
          const service = yield* WorkspaceService;
          const first = yield* service.openWorktree({
            projectId,
            request: { branch, base: { kind: 'branch', ref: 'main' } },
          });
          // No `mode`, exactly as the workspace UI calls it. The second call must adopt.
          const second = yield* service.openWorktree({ projectId, request: { branch } });
          return { first, second };
        }),
    );

    assert.equal(result.first.status, 'created');
    assert.equal(result.second.status, 'opened_existing');
    assert.equal(result.second.worktreeId, result.first.worktreeId);
    assert.deepEqual(result.second.setup, { status: 'not_run', reason: 'existing_worktree' });
    // Adoption is not a creation, so the post-create lifecycle ran exactly once.
    assert.deepEqual(commands.worktreeIds, [result.first.worktreeId]);
  });

  test('omitting mode still checks out an existing branch that has no worktree', async () => {
    const branch = 'feature/existing-branch-adopted';
    fixture.git(['branch', branch]);
    const commands = countingCommands();

    const result = await withRegisteredGitProject(
      'open-existing-branch',
      fixture.rootPath,
      commands.options,
      (projectId) =>
        Effect.gen(function* () {
          const service = yield* WorkspaceService;
          return yield* service.openWorktree({ projectId, request: { branch } });
        }),
    );

    assert.equal(result.status, 'created');
  });
});
