import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { after as afterAll, describe } from 'node:test';

import { asc } from 'drizzle-orm';
import { Effect } from 'effect';

import type { ReconciliationFinding } from '@isagi/contracts';

import type { GitService } from '../../git/index.js';
import { createFixtureWorkspace, removeTree } from '../../git/tests/fixtures.js';
import { RuntimeDatabase } from '../../persistence/index.js';
import { surfacePanes, worktreeSurfaces } from '../../persistence/schema.js';
import { WorkspaceRepository, type WorkspaceRepositoryService } from '../workspace.repository.js';
import { WorkspaceService } from '../workspace.service.js';
import { runWithLiveWorkspace } from './live-workspace-support.js';

const workspace = createFixtureWorkspace('folder-reconciliation');
afterAll(() => {
  workspace.cleanup();
});

function ordinaryFolder(name: string) {
  const path = workspace.directory(name);
  writeFileSync(join(path, 'notes.md'), '# notes\n');
  return path;
}

function gitRepository(name: string) {
  const path = workspace.directory(name);
  workspace.git(path, ['init']);
  writeFileSync(join(path, 'README.md'), '# fixture\n');
  workspace.git(path, ['add', '.']);
  workspace.git(path, ['commit', '-m', 'initial']);
  return path;
}

const readRows = Effect.gen(function* () {
  const repository = yield* WorkspaceRepository;
  return {
    projects: yield* repository.listProjects,
    worktrees: yield* repository.listWorktrees,
  };
});

/**
 * Seeds a surface and two panes onto an environment with foreign keys enforced
 * by the live database's own pragma, then reads them back.
 *
 * Test-only setup: the production reconciliation path never writes these, and
 * the point of seeding them by hand is that a cascade which removed them would
 * show up as a diff of complete rows rather than as an absence nobody looked
 * for. `dependentRows` reads the tables directly, because the snapshot builder
 * receives surfaces from a stubbed repository here and would report `[]`
 * whether the rows survived or not.
 */
function seedDependentRows(worktreeId: number) {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    yield* database.use('test_seed_dependent_rows', (db) => {
      const now = '2026-09-01T00:00:00.000Z';
      const surface = db
        .insert(worktreeSurfaces)
        .values({
          worktreeId,
          title: 'Workbench',
          layoutJson: JSON.stringify({ kind: 'leaf', nodeId: 'pane-1', paneId: 1 }),
          sortOrder: 0,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: worktreeSurfaces.id })
        .get();
      for (const [index, title] of ['Agent', 'Terminal'].entries()) {
        db.insert(surfacePanes)
          .values({
            surfaceId: surface.id,
            title,
            sortOrder: index,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      }
    });
  });
}

const dependentRows = Effect.gen(function* () {
  const database = yield* RuntimeDatabase;
  return yield* database.use('test_read_dependent_rows', (db) => ({
    surfaces: db.select().from(worktreeSurfaces).orderBy(asc(worktreeSurfaces.id)).all(),
    panes: db.select().from(surfacePanes).orderBy(asc(surfacePanes.id)).all(),
  }));
});

function reconcile(projectId: number) {
  return Effect.gen(function* () {
    const service = yield* WorkspaceService;
    const { findings } = yield* service.reconcileWorkspace({ projectId });
    return findings as readonly ReconciliationFinding[];
  });
}

describe('a folder project through its whole presence lifecycle', () => {
  test('identity, dependent rows and transition findings across every step', async () => {
    const path = ordinaryFolder('lifecycle');

    // Every Git invocation the code under test makes, in order. Classification
    // legitimately runs during registration, so this cannot be a Git that dies;
    // the reconciliation windows below assert their own slice is empty, which is
    // the same claim scoped to where it holds.
    const gitCalls: string[][] = [];
    const recordGit = (inner: GitService): GitService => ({
      run: (args, options) => {
        gitCalls.push([...args]);
        return inner.run(args, options);
      },
    });

    // Only the writes reconciliation is allowed to make. Worktree membership is
    // Git-owned for Git projects and runtime-owned for folder projects; neither
    // ownership permits the folder branch to touch it, so every worktree method
    // — reads included — is recorded and asserted empty per window.
    const worktreeCalls: string[] = [];
    const recordRepository = (inner: WorkspaceRepositoryService): WorkspaceRepositoryService => {
      const record = <A extends unknown[], R>(name: string, method: (...args: A) => R) => {
        return (...args: A) => {
          worktreeCalls.push(name);
          return method(...args);
        };
      };
      const recordValue = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
        Effect.zipRight(
          Effect.sync(() => {
            worktreeCalls.push(name);
          }),
          effect,
        );
      return {
        ...inner,
        findWorktree: record('findWorktree', inner.findWorktree),
        findProjectWorktree: record('findProjectWorktree', inner.findProjectWorktree),
        findProjectRootWorktree: record('findProjectRootWorktree', inner.findProjectRootWorktree),
        findProjectWorktreeByBranch: record(
          'findProjectWorktreeByBranch',
          inner.findProjectWorktreeByBranch,
        ),
        deleteWorktree: record('deleteWorktree', inner.deleteWorktree),
        readWorktreeDeleteDiagnostics: record(
          'readWorktreeDeleteDiagnostics',
          inner.readWorktreeDeleteDiagnostics,
        ),
        reconcileProjectWorktrees: record(
          'reconcileProjectWorktrees',
          inner.reconcileProjectWorktrees,
        ),
        restoreProjectAtRootPath: record(
          'restoreProjectAtRootPath',
          inner.restoreProjectAtRootPath,
        ),
        moveProjectWorktreeOrder: record(
          'moveProjectWorktreeOrder',
          inner.moveProjectWorktreeOrder,
        ),
        // Two of the worktree-facing members are Effect values rather than
        // functions, so they are recorded by sequencing rather than by wrapping
        // a call. `listWorktrees` is included: the assertions read it, but only
        // after each window has already been checked and closed.
        listWorktrees: recordValue('listWorktrees', inner.listWorktrees),
        listDurableSessions: recordValue('listDurableSessions', inner.listDurableSessions),
      };
    };

    await runWithLiveWorkspace(
      'folder-lifecycle',
      { decorateGit: recordGit, decorateRepository: recordRepository },
      Effect.gen(function* () {
        const service = yield* WorkspaceService;
        const { projectId } = yield* service.registerProject({ path });

        const created = yield* readRows;
        const environmentId = created.worktrees[0]?.id;
        assert.ok(environmentId);
        yield* seedDependentRows(environmentId);
        const seeded = yield* dependentRows;
        // Non-vacuity: the comparisons below mean nothing if the seed is empty.
        assert.equal(seeded.surfaces.length, 1);
        assert.equal(seeded.panes.length, 2);

        /** Asserts identity and dependent rows, and returns the transition's findings. */
        const step = (label: string, expectedStatus: 'present' | 'missing') =>
          Effect.gen(function* () {
            const before = worktreeCalls.length;
            const gitBefore = gitCalls.length;
            const findings = yield* reconcile(projectId);
            // The observation window is the reconcile call alone. The reads
            // below are legitimate and deliberately outside it.
            assert.deepEqual(
              worktreeCalls.slice(before),
              [],
              `${label}: folder reconciliation touched worktree rows`,
            );
            assert.deepEqual(
              gitCalls.slice(gitBefore),
              [],
              `${label}: folder reconciliation ran Git`,
            );

            const rows = yield* readRows;
            assert.equal(rows.projects.length, 1, `${label}: project count`);
            assert.equal(rows.projects[0]?.id, projectId, `${label}: project id`);
            assert.equal(rows.projects[0]?.kind, 'folder', `${label}: kind`);
            assert.equal(rows.projects[0]?.status, expectedStatus, `${label}: status`);
            assert.equal(rows.worktrees.length, 1, `${label}: environment count`);
            assert.deepEqual(rows.worktrees[0], created.worktrees[0], `${label}: environment row`);
            assert.deepEqual(yield* dependentRows, seeded, `${label}: dependent rows`);
            return findings;
          });

        // Present, twice: a settled project reports nothing on either sweep.
        assert.deepEqual(yield* step('present', 'present'), []);
        assert.deepEqual(yield* step('present again', 'present'), []);

        // Gone.
        removeTree(path);
        assert.deepEqual(yield* step('missing', 'missing'), [
          { kind: 'project_missing', projectId, path },
        ]);
        // Still gone: missing is not re-announced every sweep.
        assert.deepEqual(yield* step('missing again', 'missing'), []);

        const whileMissing = yield* readRows;
        assert.equal(whileMissing.projects[0]?.missingReason, `Project path not found: ${path}`);
        // The snapshot hides the environment; the row is still there.
        const hidden = yield* service.get;
        assert.deepEqual(hidden.projects[0]?.worktrees, []);
        assert.equal(whileMissing.worktrees.length, 1);

        // Back, at the same path.
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, 'notes.md'), '# notes\n');
        assert.deepEqual(yield* step('restored', 'present'), [
          { kind: 'project_restored', projectId, path },
        ]);
        assert.equal((yield* readRows).projects[0]?.missingReason, null);

        // And a repository appearing inside it later changes nothing: kind is
        // stored, so reconciliation never reclassifies.
        workspace.git(path, ['init']);
        assert.deepEqual(yield* step('after git init', 'present'), []);

        const restored = yield* service.get;
        assert.equal(restored.projects[0]?.worktrees[0]?.title, 'folder');
        assert.equal(restored.projects[0]?.worktrees[0]?.branch, null);
      }),
    );
  });
});

describe('the folder branch cannot reach Git or worktree membership', () => {
  test('reconciliation succeeds with every forbidden dependency dying', async () => {
    const path = ordinaryFolder('forbidden-boundary');

    const dyingGit = {
      run: (args: readonly string[]) =>
        Effect.die(new Error(`git must not run for a folder project: git ${args.join(' ')}`)),
    } satisfies GitService;

    const forbidWorktreeAccess = (
      inner: WorkspaceRepositoryService,
    ): WorkspaceRepositoryService => ({
      ...inner,
      findWorktree: () => Effect.die(new Error('worktree lookup must not run')),
      findProjectWorktree: () => Effect.die(new Error('project worktree lookup must not run')),
      findProjectRootWorktree: () => Effect.die(new Error('root worktree lookup must not run')),
      findProjectWorktreeByBranch: () => Effect.die(new Error('branch lookup must not run')),
      listWorktrees: Effect.die(new Error('worktrees must not be listed')),
      deleteWorktree: () => Effect.die(new Error('worktree rows must not be deleted')),
      readWorktreeDeleteDiagnostics: () => Effect.die(new Error('delete diagnostics must not run')),
      reconcileProjectWorktrees: () => Effect.die(new Error('membership must not be reconciled')),
      restoreProjectAtRootPath: () => Effect.die(new Error('restoration must not run')),
      moveProjectWorktreeOrder: () => Effect.die(new Error('worktree order must not move')),
      listDurableSessions: Effect.die(new Error('durable sessions must not be read')),
    });

    // The project is created directly, so classification — the one legitimate
    // reason for the folder path to run Git — never happens and Git can die for
    // the whole fixture. The outcome is read through `listProjects`, which is
    // project-scoped, so nothing here needs the forbidden methods either.
    const projects = await runWithLiveWorkspace(
      'forbidden-boundary',
      { decorateGit: () => dyingGit, decorateRepository: forbidWorktreeAccess },
      Effect.gen(function* () {
        const repository = yield* WorkspaceRepository;
        // Fixture construction legitimately inserts the singleton; the
        // forbidden-operation claim is scoped to reconciliation below.
        const project = yield* repository.createProject({
          name: 'forbidden-boundary',
          rootPath: path,
          kind: 'folder',
        });

        const findings = yield* reconcile(project.id);
        assert.deepEqual(findings, []);
        return yield* repository.listProjects;
      }),
    );

    assert.equal(projects.length, 1);
    assert.equal(projects[0]?.status, 'present');
  });
});

describe('presence failures are reported by cause', () => {
  test('a folder replaced by a file is not reported as missing', async () => {
    const path = ordinaryFolder('replaced-by-file');

    await runWithLiveWorkspace(
      'replaced-by-file',
      {},
      Effect.gen(function* () {
        const service = yield* WorkspaceService;
        const { projectId } = yield* service.registerProject({ path });

        removeTree(path);
        writeFileSync(path, 'a file now\n');

        const findings = yield* reconcile(projectId);
        assert.deepEqual(findings, [{ kind: 'project_missing', projectId, path }]);
        const rows = yield* readRows;
        assert.equal(rows.projects[0]?.status, 'missing');
        assert.equal(
          rows.projects[0]?.missingReason,
          `Project path is no longer a folder: ${path}`,
        );
        assert.equal(rows.worktrees.length, 1);
      }),
    );
  });

  test('a folder Isagi cannot stat says so instead of claiming it is gone', async (t) => {
    const parent = workspace.directory('unreadable-parent');
    const path = join(parent, 'project');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'notes.md'), '# notes\n');

    await runWithLiveWorkspace(
      'unreadable-folder',
      {},
      Effect.gen(function* () {
        const service = yield* WorkspaceService;
        const { projectId } = yield* service.registerProject({ path });

        chmodSync(parent, 0o000);
        try {
          // Reported honestly rather than asserted optimistically: a host or a
          // user that cannot reproduce the denial gets a skip, not a pass.
          let denied = false;
          try {
            statSync(path);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            denied = code === 'EACCES' || code === 'EPERM';
          }
          if (!denied) {
            t.skip('permission denial could not be reproduced on this platform or as this user');
            return;
          }

          const findings = yield* reconcile(projectId);
          assert.deepEqual(findings, [{ kind: 'project_missing', projectId, path }]);
          assert.equal(
            (yield* readRows).projects[0]?.missingReason,
            `Isagi cannot read the project folder: ${path}`,
          );
        } finally {
          chmodSync(parent, 0o700);
        }
      }),
    );

    rmSync(parent, { recursive: true, force: true });
  });
});

describe('a global sweep over mixed project kinds', () => {
  test('Git discovery stays scoped to Git projects and prune cleanup with it', async () => {
    const folder = ordinaryFolder('mixed-folder');
    const repository = gitRepository('mixed-git');
    const checkout = join(workspace.root, 'mixed-git-feature');
    workspace.git(repository, ['worktree', 'add', '-b', 'feature/mixed', checkout]);

    const pruneTargets: number[] = [];

    await runWithLiveWorkspace(
      'mixed-sweep',
      {
        commands: {
          cleanupBeforeWorktreePrune: (input) =>
            Effect.sync(() => {
              pruneTargets.push(input.worktreeId);
            }),
        },
      },
      Effect.gen(function* () {
        const service = yield* WorkspaceService;
        const folderProject = yield* service.registerProject({ path: folder });
        const gitProject = yield* service.registerProject({ path: repository });

        const afterRegistration = yield* readRows;
        assert.equal(afterRegistration.projects.length, 2);
        // One environment for the folder project, two checkouts for the Git one.
        assert.equal(afterRegistration.worktrees.length, 3);
        const folderEnvironment = afterRegistration.worktrees.find(
          (row) => row.projectId === folderProject.projectId,
        );
        assert.ok(folderEnvironment);

        // A Git checkout disappears. The global sweep must prune it and leave
        // the folder project's environment completely alone.
        workspace.git(repository, ['worktree', 'remove', '--force', checkout]);

        const { findings } = yield* service.reconcileWorkspace({ projectId: null });
        assert.deepEqual(
          findings.filter((finding) => finding.projectId === folderProject.projectId),
          [],
        );
        const worktreeFindings = findings.filter((finding) => finding.kind === 'worktree_missing');
        assert.equal(worktreeFindings.length, 1);
        assert.equal(worktreeFindings[0]?.projectId, gitProject.projectId);

        const after = yield* readRows;
        assert.equal(after.worktrees.length, 2);
        assert.ok(after.worktrees.some((row) => row.id === folderEnvironment.id));
        assert.equal(
          after.projects.find((row) => row.id === folderProject.projectId)?.status,
          'present',
        );

        // Prune cleanup ran, and only ever for the Git project's checkout.
        assert.equal(pruneTargets.length, 1);
        const gitWorktreeIds = new Set(
          afterRegistration.worktrees
            .filter((row) => row.projectId === gitProject.projectId)
            .map((row) => row.id),
        );
        assert.ok(pruneTargets.every((id) => gitWorktreeIds.has(id)));
      }),
    );
  });
});
