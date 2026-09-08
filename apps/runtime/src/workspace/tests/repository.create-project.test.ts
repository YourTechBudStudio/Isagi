import assert from 'node:assert/strict';
import test from 'node:test';

import { sql } from 'drizzle-orm';
import { Cause, Effect, Exit } from 'effect';

import { DatabaseError, RuntimeDatabase } from '../../persistence/index.js';
import { WorkspaceRepository } from '../workspace.repository.js';
import { runWithDatabase } from './repository-test-support.js';

/**
 * Project creation is the one write that must commit a project and, for a
 * folder project, its sole environment together. Only a real database can prove
 * the transaction boundary: the service-level tests substitute a fake
 * repository and cannot observe cardinality, rank, or rollback.
 */

/**
 * The marker the injected trigger raises. Asserting on it is what distinguishes
 * "the singleton insert was blocked" from "creation failed for some other
 * reason", which is the whole point of the rollback case.
 */
const INJECTED_FAILURE = 'isagi_test_injected_worktree_failure';

/**
 * Blocks every `worktrees` insert in this throwaway database. Test-only, and
 * deliberately installed through DDL rather than a production seam: the
 * repository has no injection point and should not grow one.
 */
function blockWorktreeInserts() {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    yield* database.use('test_block_worktree_inserts', (db) => {
      db.run(
        sql.raw(
          `CREATE TRIGGER test_block_worktree_inserts BEFORE INSERT ON worktrees
           BEGIN SELECT RAISE(ABORT, '${INJECTED_FAILURE}'); END;`,
        ),
      );
    });
  });
}

function readState() {
  return Effect.gen(function* () {
    const repository = yield* WorkspaceRepository;
    const projects = yield* repository.listProjects;
    const worktrees = yield* repository.listWorktrees;
    return {
      projects: projects.map((project) => ({
        rootPath: project.rootPath,
        kind: project.kind,
      })),
      worktrees: worktrees.map((worktree) => ({
        path: worktree.path,
        branch: worktree.branch,
        head: worktree.head,
      })),
    };
  });
}

/**
 * `DatabaseError.cause` is `unknown`, and better-sqlite3's error may or may not
 * arrive wrapped by the driver. Walk the known `Error.cause` chain rather than
 * stringifying an arbitrary value, and report what was actually found when the
 * marker is absent so a shape change fails loudly instead of silently.
 */
function causeChainMessages(cause: unknown): string[] {
  const messages: string[] = [];
  let current = cause;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages;
}

/**
 * Asserts the exit is an expected typed failure carrying a `DatabaseError`, and
 * returns it. A defect or a success would otherwise read as "the write was
 * rejected" without any rejection having been modelled.
 */
function expectDatabaseError<A, E>(exit: Exit.Exit<A, E>): DatabaseError {
  const failure = Cause.failureOption(Exit.isFailure(exit) ? exit.cause : Cause.empty);
  assert.equal(failure._tag, 'Some');
  assert.ok(failure._tag === 'Some' && failure.value instanceof DatabaseError);
  return (failure as { readonly value: DatabaseError }).value;
}

test('creating a git project inserts the project and no environment', async () => {
  const result = await runWithDatabase(
    'create-project-git',
    Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const created = yield* repository.createProject({
        name: 'isagi',
        rootPath: '/repo/isagi',
        kind: 'git',
      });
      // Compared against the repository's own mapped row, not the raw SQLite
      // record: the domain row deliberately omits stored rank.
      const persisted = yield* repository.findProject(created.id);
      return { created, persisted, state: yield* readState() };
    }),
  );

  assert.equal(result.created.kind, 'git');
  assert.equal(result.created.rootPath, '/repo/isagi');
  assert.equal(result.created.status, 'present');
  assert.equal(result.created.missingReason, null);
  assert.deepEqual(result.persisted, result.created);
  // Git membership stays Git-owned: nothing exists until discovery runs.
  assert.deepEqual(result.state.worktrees, []);
  assert.deepEqual(result.state.projects, [{ rootPath: '/repo/isagi', kind: 'git' }]);
});

test('creating a folder project inserts its sole root environment in the same unit', async () => {
  const result = await runWithDatabase(
    'create-project-folder',
    Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const created = yield* repository.createProject({
        name: 'notes',
        rootPath: '/folders/notes',
        kind: 'folder',
      });
      const persisted = yield* repository.findProject(created.id);
      const worktrees = yield* repository.listWorktrees;
      return { created, persisted, worktrees };
    }),
  );

  assert.equal(result.created.kind, 'folder');
  assert.deepEqual(result.persisted, result.created);
  assert.equal(result.worktrees.length, 1);
  const [environment] = result.worktrees;
  assert.equal(environment?.projectId, result.created.id);
  // Path equal to the project root is what makes the derived `isRoot` hold.
  assert.equal(environment?.path, '/folders/notes');
  // No branch and no head: the runtime owns this environment, Git does not.
  assert.equal(environment?.branch, null);
  assert.equal(environment?.head, null);
});

test('creation appends to the present project order regardless of kind', async () => {
  const rootPaths = await runWithDatabase(
    'create-project-append-order',
    Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      yield* repository.createProject({ name: 'alpha', rootPath: '/repo/alpha', kind: 'git' });
      yield* repository.createProject({
        name: 'notes',
        rootPath: '/folders/notes',
        kind: 'folder',
      });
      yield* repository.createProject({ name: 'bravo', rootPath: '/repo/bravo', kind: 'git' });
      return (yield* repository.listProjects).map((project) => project.rootPath);
    }),
  );

  assert.deepEqual(rootPaths, ['/repo/alpha', '/folders/notes', '/repo/bravo']);
});

test('a duplicate folder path fails and leaves exactly one project and one environment', async () => {
  const result = await runWithDatabase(
    'create-project-duplicate-folder',
    Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      // The repository is handed an already canonicalized path; alias
      // normalization belongs to registration, not to this boundary.
      yield* repository.createProject({
        name: 'notes',
        rootPath: '/folders/notes',
        kind: 'folder',
      });
      const exit = yield* Effect.exit(
        repository.createProject({ name: 'notes', rootPath: '/folders/notes', kind: 'folder' }),
      );
      return { exit, state: yield* readState() };
    }),
  );

  expectDatabaseError(result.exit);
  assert.deepEqual(result.state.projects, [{ rootPath: '/folders/notes', kind: 'folder' }]);
  assert.equal(result.state.worktrees.length, 1);
});

test('a duplicate git path fails and leaves exactly one project and no environment', async () => {
  const result = await runWithDatabase(
    'create-project-duplicate-git',
    Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      yield* repository.createProject({ name: 'isagi', rootPath: '/repo/isagi', kind: 'git' });
      const exit = yield* Effect.exit(
        repository.createProject({ name: 'isagi', rootPath: '/repo/isagi', kind: 'git' }),
      );
      return { exit, state: yield* readState() };
    }),
  );

  expectDatabaseError(result.exit);
  assert.deepEqual(result.state.projects, [{ rootPath: '/repo/isagi', kind: 'git' }]);
  assert.deepEqual(result.state.worktrees, []);
});

test('a blocked singleton insert rolls the whole folder project back', async () => {
  const result = await runWithDatabase(
    'create-project-rollback',
    Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      yield* blockWorktreeInserts();

      // Control: the trigger is inert on the project insert. A Git project
      // still creates cleanly, which is what stops the folder rollback below
      // from passing because project insertion broke in general.
      const control = yield* repository.createProject({
        name: 'isagi',
        rootPath: '/repo/isagi',
        kind: 'git',
      });

      // Distinct path, so uniqueness cannot be what fails the folder attempt.
      const before = yield* readState();
      const exit = yield* Effect.exit(
        repository.createProject({ name: 'notes', rootPath: '/folders/notes', kind: 'folder' }),
      );
      return { control, before, exit, after: yield* readState() };
    }),
  );

  assert.equal(result.control.kind, 'git');

  const failure = expectDatabaseError(result.exit);
  assert.equal(failure.operation, 'create_project');
  const messages = causeChainMessages(failure.cause);
  assert.ok(
    messages.some((message) => message.includes(INJECTED_FAILURE)),
    `Expected the injected trigger to be the cause. Cause chain: ${JSON.stringify(messages)}`,
  );

  // Rollback is relative to the pre-attempt state, not to an empty database:
  // the control project must survive, and the folder project must be absent
  // along with the environment whose insert was blocked.
  assert.deepEqual(result.after, result.before);
  assert.deepEqual(result.after.projects, [{ rootPath: '/repo/isagi', kind: 'git' }]);
  assert.deepEqual(result.after.worktrees, []);
});
