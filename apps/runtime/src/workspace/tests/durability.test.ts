import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Schema, type Layer } from 'effect';

import { workspaceSnapshotSchema } from '@isagi/contracts';

import { createFixtureWorkspace, removeTree } from '../../git/tests/fixtures.js';
import { RuntimeDatabase, type RuntimeDatabaseService } from '../../persistence/index.js';
import {
  surfacePanes,
  worktreeEnvironmentStates,
  worktrees,
  worktreeSurfaces,
} from '../../persistence/schema.js';
import { SurfaceRepository, SurfaceService } from '../../surfaces/index.js';
// The surfaces layer is the only test layer that composes all three ordered
// scopes at once, and this test is specifically about the three surviving
// together. Rebuilding that graph here would be a second definition of the
// same wiring.
import { addPaneToSurface, testLayer } from '../../surfaces/tests/test-support.js';
import { WorkspaceRepository, type WorkspaceRepositoryService } from '../workspace.repository.js';
import { WorkspaceService } from '../workspace.service.js';
import { buildWorkspaceSnapshot, FOLDER_ENVIRONMENT_TITLE } from '../workspace.snapshot.js';
import { liveWorkspaceLayer } from './live-workspace-support.js';

/**
 * Order is durable or it is not a feature: a rank that only survives while the
 * process is up would look correct in every other test in this repository.
 *
 * Each phase below builds its own scoped layer over the same data directory, so
 * the SQLite connection is genuinely closed and reopened between writing the
 * order and reading it back. Reusing one layer (or one live connection) would
 * prove nothing beyond in-memory consistency.
 */

type SurfaceTestServices = Layer.Layer.Success<ReturnType<typeof testLayer>>;

/** Runs one program against `dataRoot` in its own scope, then closes it. */
function inFreshScope<A, E>(dataRoot: string, build: Effect.Effect<A, E, SurfaceTestServices>) {
  return Effect.runPromise(build.pipe(Effect.provide(testLayer(dataRoot))));
}

function readSnapshot() {
  return Effect.gen(function* () {
    const repository = yield* WorkspaceRepository;
    const surfaceRepository = yield* SurfaceRepository;
    return buildWorkspaceSnapshot(
      yield* repository.listProjects,
      yield* repository.listWorktrees,
      yield* surfaceRepository.listWorkspaceSurfaceMetadata,
      yield* surfaceRepository.listEnvironmentFocusStates,
    );
  });
}

test('project, worktree, and surface order survive closing and reopening the database', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-durability-'));

  try {
    const written = await inFreshScope(
      dataRoot,
      Effect.gen(function* () {
        const repository = yield* WorkspaceRepository;
        const surfaces = yield* SurfaceService;

        const projectIds: number[] = [];
        for (const name of ['alpha', 'beta', 'gamma', 'delta']) {
          projectIds.push(
            (yield* repository.createProject({ name, rootPath: `/repo/${name}`, kind: 'git' })).id,
          );
        }
        const [alpha, , gamma, delta] = projectIds as [number, number, number, number];

        // A missing project must stay outside the ranked present section across
        // a restart, not merely on the write that made it missing.
        yield* repository.setProjectStatus({
          id: delta,
          status: 'missing',
          missingReason: 'Directory no longer exists.',
        });

        // gamma, alpha, beta.
        yield* repository.moveProjectOrder({ projectId: gamma, beforeProjectId: alpha });

        // The root is discovered first so its identifier is lowest; the reorder
        // below then puts the non-root worktrees in an order the identifier
        // tie-break alone could not produce.
        yield* repository.reconcileProjectWorktrees({
          projectId: alpha,
          discovered: [
            { path: '/repo/alpha', branch: 'main', head: 'aaa0001' },
            { path: '/repo/alpha/wt-one', branch: 'one', head: 'aaa0002' },
            { path: '/repo/alpha/wt-two', branch: 'two', head: 'aaa0003' },
            { path: '/repo/alpha/wt-three', branch: 'three', head: 'aaa0004' },
          ],
        });
        const alphaWorktrees = (yield* repository.listWorktrees).filter(
          (worktree) => worktree.projectId === alpha,
        );
        const worktreeId = (path: string) => {
          const found = alphaWorktrees.find((worktree) => worktree.path === path);
          if (!found) throw new Error(`Missing test worktree ${path}.`);
          return found.id;
        };
        // three, one, two.
        yield* repository.moveProjectWorktreeOrder({
          projectId: alpha,
          worktreeId: worktreeId('/repo/alpha/wt-three'),
          beforeWorktreeId: worktreeId('/repo/alpha/wt-one'),
        });

        const rootWorktreeId = worktreeId('/repo/alpha');
        const surfaceIds: number[] = [];
        for (const titleBase of ['Agent', 'Terminal', 'Notes']) {
          const created = yield* surfaces.createSinglePaneSurface({
            worktreeId: rootWorktreeId,
            titleBase,
          });
          surfaceIds.push(created.surfaceId);
        }
        const [agent, , notes] = surfaceIds as [number, number, number];
        // Notes, Agent, Terminal.
        yield* surfaces.moveSurfaceOrder({
          worktreeId: rootWorktreeId,
          surfaceId: notes,
          beforeSurfaceId: agent,
        });

        return yield* readSnapshot();
      }),
    );

    // Written and read in two different processes-worth of connections.
    const reopened = await inFreshScope(dataRoot, readSnapshot());

    assert.deepEqual(
      reopened.projects.map((project) => project.name),
      ['gamma', 'alpha', 'beta', 'delta'],
    );
    assert.deepEqual(
      reopened.projects.map((project) => project.status),
      ['present', 'present', 'present', 'missing'],
    );

    const alphaProject = reopened.projects.find((project) => project.name === 'alpha');
    assert.deepEqual(
      alphaProject?.worktrees.map((worktree) => worktree.branch),
      ['main', 'three', 'one', 'two'],
    );
    assert.deepEqual(
      alphaProject?.worktrees.map((worktree) => worktree.isRoot),
      [true, false, false, false],
    );

    const rootWorktree = alphaProject?.worktrees.find((worktree) => worktree.isRoot);
    assert.deepEqual(
      rootWorktree?.surfaces.map((surface) => surface.title),
      ['Notes', 'Agent', 'Terminal'],
    );

    // The reopened snapshot must equal the one the writing scope saw. Asserting
    // this separately catches an order that is stable across a restart but was
    // already wrong when written.
    assert.deepEqual(reopened, written);

    // Order is expressed only through array position. A rank leaking into the
    // DTO would make the client a second place order could be derived from.
    //
    // Asserted against the composed snapshot rather than the encoded output:
    // encoding strips excess properties, so a leaked rank would be laundered by
    // the very step meant to reveal it. The encode is still run, because it is
    // what proves the snapshot satisfies the published contract at all.
    Schema.encodeSync(workspaceSnapshotSchema)(reopened);
    assert.equal(JSON.stringify(reopened).includes('sortOrder'), false);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

/**
 * A folder project has no Git to rediscover it from. Its environment, and every
 * surface and pane hanging off it, exist only as rows — so "the project came
 * back" and "the project's contents came back" are separate claims, and only a
 * genuine close and reopen can tell them apart.
 *
 * The sequence below is one story told across five scopes over a single data
 * directory. Each stage is named, and each asserts before it acts, so a failure
 * says which transition broke rather than only that the ending was wrong.
 *
 * Two compositions appear here because their dependencies genuinely differ:
 * registration and reconciliation need the workspace service and real Git,
 * while surfaces and focus need the surface service. Neither needs the other's
 * graph, and each scope closes its connection before the next opens one.
 */
test('a folder project, its environment, surfaces, panes, and focus survive loss, restoration, and a later git init', async () => {
  const fixtures = createFixtureWorkspace('folder-durability');
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-folder-durability-'));
  const projectPath = fixtures.directory('notes');
  mkdirSync(join(projectPath, 'src'), { recursive: true });
  writeFileSync(join(projectPath, 'src', 'main.ts'), 'export const main = 1;\n');
  writeFileSync(join(projectPath, 'notes.md'), '# notes\n');

  /** One workspace scope: real service, real repository, real Git, own connection. */
  const inWorkspaceScope = <A, E>(
    build: Effect.Effect<
      A,
      E,
      RuntimeDatabaseService | WorkspaceRepositoryService | WorkspaceService
    >,
  ) => Effect.runPromise(build.pipe(Effect.provide(liveWorkspaceLayer(dataRoot, {}))));

  try {
    // ── Stage 1: register the folder ────────────────────────────────────────
    const registered = await inWorkspaceScope(
      Effect.gen(function* () {
        const service = yield* WorkspaceService;
        const repository = yield* WorkspaceRepository;
        const added = yield* service.registerProject({ path: projectPath });
        const environment = (yield* repository.listWorktrees).find(
          (row) => row.projectId === added.projectId,
        );
        if (!environment) throw new Error('Expected the folder project to own an environment.');
        return { projectId: added.projectId, worktreeId: environment.id };
      }),
    );

    // ── Stage 2: furnish the environment ────────────────────────────────────
    // Ordering and focus have to be non-default to be worth asserting: three
    // surfaces reordered away from creation order, a second pane on one of
    // them, and focus parked on a surface that is neither first nor last.
    const furnished = await inFreshScope(
      dataRoot,
      Effect.gen(function* () {
        const surfaces = yield* SurfaceService;
        const created: Array<{
          readonly title: string;
          readonly surfaceId: number;
          readonly paneId: number;
        }> = [];
        for (const titleBase of ['Agent', 'Terminal', 'Notes']) {
          const surface = yield* surfaces.createSinglePaneSurface({
            worktreeId: registered.worktreeId,
            titleBase,
          });
          created.push({ title: titleBase, surfaceId: surface.surfaceId, paneId: surface.paneId });
        }
        const [agent, terminal, notes] = created as [
          (typeof created)[number],
          (typeof created)[number],
          (typeof created)[number],
        ];
        // Notes, Agent, Terminal — creation order was Agent, Terminal, Notes.
        yield* surfaces.moveSurfaceOrder({
          worktreeId: registered.worktreeId,
          surfaceId: notes.surfaceId,
          beforeSurfaceId: agent.surfaceId,
        });
        const secondPaneId = yield* addPaneToSurface(agent.surfaceId);
        yield* surfaces.setWorktreeEnvironmentFocus({
          worktreeId: registered.worktreeId,
          focus: { activeSurfaceId: agent.surfaceId, activePaneId: secondPaneId },
        });
        return { agent, terminal, notes, secondPaneId };
      }),
    );

    // ── Stage 3: the folder disappears ──────────────────────────────────────
    // Created through actual disappearance and reconciliation, not by writing
    // `status: 'missing'` — the transition under test is the one the product
    // performs.
    removeTree(projectPath);
    const lost = await inWorkspaceScope(
      Effect.gen(function* () {
        const service = yield* WorkspaceService;
        return yield* service.reconcileWorkspace({ projectId: registered.projectId });
      }),
    );
    assert.deepEqual(lost.findings, [
      { kind: 'project_missing', projectId: registered.projectId, path: projectPath },
    ]);

    // ── Stage 4: reopen, verify the loss persisted, then restore ────────────
    const restored = await inWorkspaceScope(
      Effect.gen(function* () {
        const service = yield* WorkspaceService;
        const repository = yield* WorkspaceRepository;
        const database = yield* RuntimeDatabase;

        // The missing state itself survived the reopen.
        const beforeProjects = yield* repository.listProjects;
        const beforeProject = beforeProjects.find((row) => row.id === registered.projectId);
        assert.equal(beforeProject?.status, 'missing');
        assert.equal(beforeProject?.kind, 'folder');
        assert.ok(beforeProject?.missingReason);

        // Durable rows, read directly. The snapshot projects `worktrees: []`
        // for a missing project, so it cannot distinguish "hidden" from
        // "deleted" — only the tables can.
        const rows = yield* database.use('test_read_folder_durability_rows', (db) => ({
          worktreeRows: db.select().from(worktrees).all(),
          surfaces: db.select().from(worktreeSurfaces).all(),
          panes: db.select().from(surfacePanes).all(),
        }));
        assert.deepEqual(
          rows.worktreeRows.map((row) => row.id),
          [registered.worktreeId],
        );
        assert.equal(rows.surfaces.length, 3);
        assert.equal(rows.panes.length, 4);

        const hiddenSnapshot = yield* service.get;
        assert.deepEqual(
          hiddenSnapshot.projects.find((p) => p.id === registered.projectId)?.worktrees,
          [],
        );

        // Same path, same contents.
        mkdirSync(join(projectPath, 'src'), { recursive: true });
        writeFileSync(join(projectPath, 'src', 'main.ts'), 'export const main = 1;\n');
        writeFileSync(join(projectPath, 'notes.md'), '# notes\n');
        const afterRestore = yield* service.reconcileWorkspace({
          projectId: registered.projectId,
        });

        // A repository appearing inside a folder project changes nothing: kind
        // is immutable and reconciliation is presence-only.
        fixtures.git(projectPath, ['init']);
        const afterGitInit = yield* service.reconcileWorkspace({
          projectId: registered.projectId,
        });

        return { afterRestore: afterRestore.findings, afterGitInit: afterGitInit.findings };
      }),
    );
    assert.deepEqual(restored.afterRestore, [
      { kind: 'project_restored', projectId: registered.projectId, path: projectPath },
    ]);
    assert.deepEqual(restored.afterGitInit, []);

    // ── Stage 5: reopen once more and read the final facts ──────────────────
    // Read-only: this stage asserts what survived, and mutates nothing.
    const {
      snapshot: final,
      paneRows,
      focusRows,
    } = await inFreshScope(
      dataRoot,
      Effect.gen(function* () {
        const database = yield* RuntimeDatabase;
        return {
          snapshot: yield* readSnapshot(),
          paneRows: yield* database.use('test_read_folder_durability_panes', (db) =>
            db.select().from(surfacePanes).orderBy(surfacePanes.id).all(),
          ),
          focusRows: yield* database.use('test_read_folder_durability_focus', (db) =>
            db.select().from(worktreeEnvironmentStates).all(),
          ),
        };
      }),
    );
    const project = final.projects.find((candidate) => candidate.id === registered.projectId);
    assert.ok(project);
    assert.equal(project.kind, 'folder');
    assert.equal(project.status, 'present');
    assert.equal(project.rootPath, projectPath);
    // A present project carries no reason at all, rather than a null one.
    assert.equal(project.missingReason, undefined);

    assert.equal(project.worktrees.length, 1);
    const environment = project.worktrees[0];
    assert.ok(environment);
    // Identity, not merely shape: the same row the project was registered with.
    assert.equal(environment.id, registered.worktreeId);
    assert.equal(environment.path, projectPath);
    assert.equal(environment.title, FOLDER_ENVIRONMENT_TITLE);
    assert.equal(environment.branch, null);
    assert.equal(environment.head, null);
    assert.equal(environment.isRoot, true);

    assert.deepEqual(
      environment.surfaces.map((surface) => surface.title),
      ['Notes', 'Agent', 'Terminal'],
    );
    assert.deepEqual(
      environment.surfaces.map((surface) => surface.id),
      [furnished.notes.surfaceId, furnished.agent.surfaceId, furnished.terminal.surfaceId],
    );
    assert.equal(environment.activeSurfaceId, furnished.agent.surfaceId);

    // The snapshot projects the focused *surface* and nothing more, so the
    // focused pane — the half this fixture deliberately parked away from the
    // default — is only observable in its own table. Asserting the surface
    // alone would pass while pane focus was cleared or moved.
    assert.deepEqual(
      focusRows.map((row) => ({
        worktreeId: row.worktreeId,
        activeSurfaceId: row.activeSurfaceId,
        activePaneId: row.activePaneId,
      })),
      [
        {
          worktreeId: registered.worktreeId,
          activeSurfaceId: furnished.agent.surfaceId,
          activePaneId: furnished.secondPaneId,
        },
      ],
    );

    // `paneKinds` lists only panes with a bound session, and this test binds
    // none — sessions are `session-restore.test.ts`'s subject. Pinning the
    // empty projection keeps that boundary honest; the panes themselves are
    // asserted as rows below, which is where their survival actually shows.
    assert.deepEqual(
      environment.surfaces.map((surface) => surface.paneKinds),
      [[], [], []],
    );
    assert.equal(paneRows.length, 4);
    assert.deepEqual(
      paneRows.filter((row) => row.surfaceId === furnished.agent.surfaceId).map((row) => row.id),
      [furnished.agent.paneId, furnished.secondPaneId],
    );

    Schema.encodeSync(workspaceSnapshotSchema)(final);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
    fixtures.cleanup();
  }
});
