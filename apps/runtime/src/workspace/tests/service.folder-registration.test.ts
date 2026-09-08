import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import test, { after as afterAll, describe } from 'node:test';

import { Effect, Schema } from 'effect';

import { workspaceSnapshotSchema } from '@isagi/contracts';

import { createFixtureWorkspace, removeTree } from '../../git/tests/fixtures.js';
import { WorkspaceRepository } from '../workspace.repository.js';
import { WorkspaceError, WorkspaceService } from '../workspace.service.js';
import { runWithLiveWorkspace } from './live-workspace-support.js';

const workspace = createFixtureWorkspace('folder-registration');
afterAll(() => {
  workspace.cleanup();
});

/**
 * Every path beneath `root`, relative and sorted, with directories marked. The
 * instrument for "Isagi did not write anything into the user's folder": a
 * created `.git`, a copied template or a stray lock file all show up as a diff
 * of two of these rather than as a single hand-picked `existsSync` check.
 */
function treeOf(root: string): string[] {
  const entries: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const absolute = join(directory, entry.name);
      entries.push(`${entry.isDirectory() ? 'd' : 'f'} ${relative(root, absolute)}`);
      if (entry.isDirectory()) {
        walk(absolute);
      }
    }
  };
  walk(root);
  return entries;
}

function ordinaryFolder(name: string) {
  const path = workspace.directory(name);
  mkdirSync(join(path, 'src'), { recursive: true });
  writeFileSync(join(path, 'src', 'main.ts'), 'export const main = 1;\n');
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

describe('registering an ordinary folder', () => {
  test('creates one folder project owning a single default environment', async () => {
    const path = ordinaryFolder('plain-project');
    const before = treeOf(path);

    const registered = await runWithLiveWorkspace(
      'folder-register',
      {},
      Effect.gen(function* () {
        const service = yield* WorkspaceService;
        const added = yield* service.registerProject({ path });
        return { added, snapshot: yield* service.get, rows: yield* readRows };
      }),
    );

    const { added, snapshot, rows } = registered;
    assert.equal(added.alreadyExisted, false);
    assert.equal(rows.projects.length, 1);
    assert.equal(rows.worktrees.length, 1);

    const project = snapshot.projects[0];
    assert.ok(project);
    assert.equal(project.kind, 'folder');
    assert.equal(project.status, 'present');
    // The fixture root is already realpath-canonical, so an unchanged path here
    // is the canonicalization assertion, not a coincidence.
    assert.equal(project.rootPath, path);
    assert.equal(project.name, 'plain-project');
    assert.equal(project.worktrees.length, 1);

    const environment = project.worktrees[0];
    assert.ok(environment);
    assert.equal(environment.title, 'folder');
    assert.equal(environment.path, path);
    assert.equal(environment.branch, null);
    assert.equal(environment.head, null);
    assert.equal(environment.isRoot, true);

    assert.doesNotThrow(() => Schema.decodeUnknownSync(workspaceSnapshotSchema)(snapshot));

    // Registration is a read of the folder and a write to the database.
    assert.deepEqual(treeOf(path), before);
    assert.equal(existsSync(join(path, '.git')), false);
  });

  test('leaves nothing behind when classification refuses the path', async () => {
    const repository = gitRepository('refused-parent');
    const subdirectory = join(repository, 'src');
    mkdirSync(subdirectory, { recursive: true });

    const bare = workspace.directory('refused-bare');
    workspace.git(bare, ['init', '--bare', '.']);

    const shadowed = workspace.directory('refused-shadowed');
    mkdirSync(join(shadowed, '.git'), { recursive: true });
    writeFileSync(join(shadowed, '.git', 'HEAD'), 'not a ref\n');
    const shadowedChild = join(shadowed, 'child');
    mkdirSync(shadowedChild, { recursive: true });

    for (const [path, reason] of [
      [subdirectory, 'not_repository_root'],
      [bare, 'bare_repository'],
      [shadowedChild, 'git_metadata_unreadable'],
    ] as const) {
      const refused = await runWithLiveWorkspace(
        'folder-register-refused',
        {},
        Effect.gen(function* () {
          const service = yield* WorkspaceService;
          const rejection = yield* Effect.flip(service.registerProject({ path }));
          return { rejection, rows: yield* readRows };
        }),
      );

      const { rejection, rows } = refused;
      assert.equal((rejection as { readonly code: string }).code, reason, `for ${path}`);
      // The obligation phase 02 deferred: a refused classification must leave no
      // project and no environment, not merely return the right reason.
      assert.deepEqual(rows.projects, [], `projects after refusing ${path}`);
      assert.deepEqual(rows.worktrees, [], `worktrees after refusing ${path}`);
    }
  });
});

describe('identity survives re-adding the same folder', () => {
  test('a duplicate add, an alias and a later git init all return the first project', async () => {
    const path = ordinaryFolder('durable-identity');
    const alias = join(workspace.root, 'durable-identity-alias');
    symlinkSync(path, alias);

    await runWithLiveWorkspace(
      'folder-identity',
      {},
      Effect.gen(function* () {
        const service = yield* WorkspaceService;

        const first = yield* service.registerProject({ path });
        const created = (yield* readRows).projects[0];
        assert.ok(created);
        const environmentId = (yield* readRows).worktrees[0]?.id;
        assert.ok(environmentId);

        const again = yield* service.registerProject({ path });
        assert.deepEqual(again, { projectId: first.projectId, alreadyExisted: true });

        // The alias canonicalizes to the same physical directory, so it is the
        // same registration rather than a second project at a second path.
        const viaAlias = yield* service.registerProject({ path: alias });
        assert.deepEqual(viaAlias, { projectId: first.projectId, alreadyExisted: true });

        // Stored kind wins. `git init` inside a registered folder project does
        // not reclassify it, because classification never runs for a path that
        // already has a registration.
        workspace.git(path, ['init']);
        const afterInit = yield* service.registerProject({ path });
        assert.deepEqual(afterInit, { projectId: first.projectId, alreadyExisted: true });

        const rows = yield* readRows;
        assert.equal(rows.projects.length, 1);
        assert.equal(rows.worktrees.length, 1);
        assert.equal(rows.projects[0]?.kind, 'folder');
        assert.equal(rows.projects[0]?.status, 'present');
        assert.equal(rows.worktrees[0]?.id, environmentId);
        assert.equal(rows.worktrees[0]?.branch, null);

        // And the runtime guards still hold: a folder project that now contains
        // a repository is still a folder project, so checkout management is
        // still refused rather than quietly becoming available.
        const refusal = yield* Effect.flip(
          service.listProjectBranches({ projectId: first.projectId }),
        );
        assert.ok(refusal instanceof WorkspaceError);
        assert.equal(refusal.code, 'worktrees_not_supported');
      }),
    );
  });

  test('a registration whose path would no longer classify is still returned by id', async () => {
    // The load-bearing case for "classification runs only for a path with no
    // registration". Every other re-add fixture still classifies successfully,
    // so ordering the lookup after classification would pass them; this one has
    // acquired metadata that classification *refuses*, and a re-add that still
    // consulted it would fail with `git_metadata_unreadable` instead of
    // returning the project the user already has.
    const path = ordinaryFolder('unclassifiable-later');

    await runWithLiveWorkspace(
      'unclassifiable-later',
      {},
      Effect.gen(function* () {
        const service = yield* WorkspaceService;
        const first = yield* service.registerProject({ path });

        mkdirSync(join(path, '.git'), { recursive: true });
        writeFileSync(join(path, '.git', 'HEAD'), 'garbage\n');

        const again = yield* service.registerProject({ path });
        assert.deepEqual(again, { projectId: first.projectId, alreadyExisted: true });

        const rows = yield* readRows;
        assert.equal(rows.projects.length, 1);
        assert.equal(rows.projects[0]?.kind, 'folder');
        assert.equal(rows.worktrees.length, 1);
      }),
    );
  });

  test('re-adding a registered Git root whose Git has broken reports it missing', async () => {
    const path = gitRepository('broken-git');

    await runWithLiveWorkspace(
      'broken-git-readd',
      {},
      Effect.gen(function* () {
        const service = yield* WorkspaceService;
        const first = yield* service.registerProject({ path });
        const before = yield* readRows;
        assert.equal(before.projects[0]?.kind, 'git');
        assert.equal(before.projects[0]?.status, 'present');

        // Not a missing directory — a directory Git can no longer read. Before
        // this phase the re-add was refused outright with `not_git_repository`.
        removeTree(join(path, '.git'));

        const again = yield* service.registerProject({ path });
        assert.deepEqual(again, { projectId: first.projectId, alreadyExisted: true });

        const after = yield* readRows;
        assert.equal(after.projects.length, 1);
        assert.equal(after.projects[0]?.kind, 'git');
        assert.equal(after.projects[0]?.status, 'missing');
        assert.match(after.projects[0]?.missingReason ?? '', /Could not read Git worktrees/);
      }),
    );
  });
});

describe('registration runs no post-create automation', () => {
  test('neither kind triggers command postCreate or worktree setup', async () => {
    // `runPostCreateLifecycle` and the setup services die in the live harness,
    // so reaching either fails by name. Both kinds go through the same call.
    const folder = ordinaryFolder('no-automation-folder');
    const repository = gitRepository('no-automation-git');

    const rows = await runWithLiveWorkspace(
      'no-automation',
      {},
      Effect.gen(function* () {
        const service = yield* WorkspaceService;
        yield* service.registerProject({ path: folder });
        yield* service.registerProject({ path: repository });
        return yield* readRows;
      }),
    );

    assert.deepEqual(rows.projects.map((project) => project.kind).sort(), ['folder', 'git']);
    // The Git project's own checkout is discovered by reconciliation; the folder
    // project's environment was created with it.
    assert.equal(rows.worktrees.length, 2);
    assert.ok(statSync(folder).isDirectory());
  });
});
