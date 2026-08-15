import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Schema, type Layer } from 'effect';

import { workspaceSnapshotSchema } from '@isagi/contracts';

import { SurfaceRepository, SurfaceService } from '../../surfaces/index.js';
// The surfaces layer is the only test layer that composes all three ordered
// scopes at once, and this test is specifically about the three surviving
// together. Rebuilding that graph here would be a second definition of the
// same wiring.
import { testLayer } from '../../surfaces/tests/test-support.js';
import { WorkspaceRepository } from '../workspace.repository.js';
import { buildWorkspaceSnapshot } from '../workspace.snapshot.js';

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
          projectIds.push(yield* repository.insertProject({ name, rootPath: `/repo/${name}` }));
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
