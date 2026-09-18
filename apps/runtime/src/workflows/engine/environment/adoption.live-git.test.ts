import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { Effect } from 'effect';

import { RuntimeDatabase, type RuntimeDatabaseService } from '../../../persistence/index.js';
import * as schema from '../../../persistence/schema.js';
import {
  createGitProjectFixture,
  withRegisteredGitProject,
} from '../../../workspace/tests/live-git-support.js';
import { WorkspaceRepository } from '../../../workspace/workspace.repository.js';
import { WorkspaceService } from '../../../workspace/workspace.service.js';
import { makeWorkflowContentStore } from '../../persistence/content-store.js';
import { makeWorkflowPayloadStore } from '../../persistence/payload-store.js';
import { makeWorkflowRunsRepository } from '../../persistence/runs.repository.js';
import { prepareEnvironment } from './preparation.js';
import type { PreparationDeps } from './types.js';

/**
 * Adoption of a checkout an interrupted attempt left behind — against real Git.
 *
 * Everything else about preparation is proved against doubles in
 * [`../environment.test.ts`](../environment.test.ts), and deliberately so: composition, receipt
 * ordering and re-entry are all about what a second attempt *sees*, which real rows answer and a
 * real repository only slows down. This one scenario is the exception, for three reasons a double
 * cannot reach.
 *
 * **`first_seen_at` is written by real reconciliation.** The adoption predicate compares it to the
 * preparation's `created_at`, and a fake that chooses both values tests the comparison rather than
 * the thing being compared. It also settles, by behaviour rather than by inspection, that the two
 * columns are the same ISO format from the same clock — if they were not, this test fails instead
 * of a string comparison passing by luck.
 *
 * **The reconcile-before-collision ordering lives inside `openWorktree`.** The crashed attempt
 * created a checkout Git holds and no row names. Only the retry's *own* reconcile, which
 * `openWorktree` runs before its collision checks, writes that row — and without it
 * `findProjectWorktreeByBranch` would return null, the predicate would have nothing to judge, and
 * the run would be permanently stuck behind a checkout Git refuses to recreate. Through a fake that
 * ordering is invisible by construction, so the scenario that most depends on it would be the one
 * scenario unable to observe it.
 *
 * **The approval record lists it as an evidence obligation.** The predicate was accepted against a
 * named false-positive window, and the person who accepted that risk is owed evidence from the real
 * mechanism rather than from a restatement of the assumption.
 */

const OWNER = 'workflow-launch:live-git';
const INCARNATION = 'incarnation:live-git';
const ARTIFACT_HASH = 'c'.repeat(64);

interface Fixtures {
  readonly database: RuntimeDatabaseService;
  readonly runs: ReturnType<typeof makeWorkflowRunsRepository>;
  readonly payloadRoot: string;
}

function makeWorkflowFixtures(database: RuntimeDatabaseService): Fixtures {
  const payloadRoot = mkdtempSync(join(tmpdir(), 'isagi-live-adoption-payloads-'));
  const payloads = makeWorkflowPayloadStore(makeWorkflowContentStore(payloadRoot, database));
  return { database, runs: makeWorkflowRunsRepository(database, payloads), payloadRoot };
}

/** A catalog row, so the run and its attempts have a real pin to reference. */
function seedArtifact(database: RuntimeDatabaseService) {
  return database.use('seed_artifact', (db) => {
    db.insert(schema.workflowArtifacts)
      .values({
        artifactHash: ARTIFACT_HASH,
        workflowKey: 'adoptable',
        contractVersion: 3,
        manifestVersion: 2,
        descriptorVersion: 1,
        sdkVersion: '0.2.0',
        verifierVersion: '0.2.0',
        sourceHash: 's'.repeat(64),
        structureHash: 'h'.repeat(64),
        rootGraphKey: 'root',
        descriptorInline: '{}',
        firstSeenAt: '2026-01-01T00:00:00.000Z',
      })
      .onConflictDoNothing()
      .run();
  });
}

/**
 * Surfaces, as real rows over the same database.
 *
 * The live workspace layer stubs the surface repository out, because nothing it tests needs one.
 * Preparation does: it reads the origin surface and creates the destination one. These are the two
 * operations it uses, writing the same columns the surfaces repository writes, so the keyed
 * re-entry and the worktree membership check both work against real state.
 */
function surfaces(database: RuntimeDatabaseService) {
  const create = (input: {
    readonly worktreeId: number;
    readonly titleBase: string;
    readonly creationKey?: string | undefined;
  }) =>
    database.use('create_surface', (db) => {
      const keyed =
        input.creationKey === undefined
          ? undefined
          : db
              .select()
              .from(schema.worktreeSurfaces)
              .where(eq(schema.worktreeSurfaces.creationKey, input.creationKey))
              .get();
      if (keyed) {
        const pane = db
          .select()
          .from(schema.surfacePanes)
          .where(eq(schema.surfacePanes.surfaceId, keyed.id))
          .get()!;
        return { surfaceId: keyed.id, paneId: pane.id, title: keyed.title, cwd: '' };
      }
      const now = new Date().toISOString();
      const surface = db
        .insert(schema.worktreeSurfaces)
        .values({
          worktreeId: input.worktreeId,
          title: input.titleBase,
          layoutJson: '{}',
          sortOrder: 0,
          creationKey: input.creationKey ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: schema.worktreeSurfaces.id })
        .get();
      const pane = db
        .insert(schema.surfacePanes)
        .values({
          surfaceId: surface.id,
          title: input.titleBase,
          sortOrder: 0,
          sessionKind: null,
          sessionId: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: schema.surfacePanes.id })
        .get();
      return { surfaceId: surface.id, paneId: pane.id, title: input.titleBase, cwd: '' };
    });

  const find = (surfaceId: number) =>
    database.use('find_surface', (db) => {
      const row = db
        .select()
        .from(schema.worktreeSurfaces)
        .where(eq(schema.worktreeSurfaces.id, surfaceId))
        .get();
      return row ? { id: row.id, worktreeId: row.worktreeId, title: row.title } : null;
    });

  return { create, find };
}

test('Retry adopts a checkout its interrupted attempt really created, and re-runs setup for it', async () => {
  const git = createGitProjectFixture('workflow-adoption');
  git.commit('second');
  const baseBranch = git.git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  let payloadRoot = '';
  /**
   * The post-create command lifecycle, allowed rather than forbidden here.
   *
   * The live fixture dies on it by default, because registration and reconciliation must never run
   * it. `runWorktreeSetup` is the one caller that legitimately does — re-running hooks and then the
   * post-create lifecycle is what it *is* — so this test opts in and records the call instead, which
   * is also how it observes that setup really re-ran against the adopted checkout.
   */
  const postCreate: number[] = [];

  try {
    await withRegisteredGitProject(
      'workflow-adoption',
      git.rootPath,
      {
        commands: {
          runPostCreateLifecycle: (input: { readonly worktreeId: number }) =>
            Effect.sync(() => {
              postCreate.push(input.worktreeId);
            }),
        },
      },
      (projectId) =>
        Effect.gen(function* () {
          const database = yield* RuntimeDatabase;
          const workspace = yield* WorkspaceRepository;
          const service = yield* WorkspaceService;
          const fixtures = makeWorkflowFixtures(database);
          payloadRoot = fixtures.payloadRoot;
          const surfaceRows = surfaces(database);
          yield* seedArtifact(database);

          const rootWorktree = (yield* workspace.listWorktrees).find(
            (worktree) => worktree.projectId === projectId,
          )!;
          const origin = yield* surfaceRows.create({
            worktreeId: rootWorktree.id,
            titleBase: 'Origin',
          });

          // The decision, made before anything is allocated: the commit `main` pointed at, and the
          // checkout path Isagi derives for the branch. Both come from the real preflight.
          const branch = 'feature/adopted';
          const preflight = yield* service.preflightWorktreeCreation({
            projectId,
            branch,
            fromRef: baseBranch,
          });

          const created = yield* fixtures.runs.createRun({
            workflowKey: 'adoptable',
            title: 'Adoptable',
            rootGraphKey: 'root',
            artifactHash: ARTIFACT_HASH,
            rootFrame: { graphKey: 'root', parameters: { value: {} } },
            origin: {
              worktreeId: rootWorktree.id,
              worktreePath: rootWorktree.path,
              surfaceId: origin.surfaceId,
              paneId: null,
              agentSessionId: null,
            },
            preparation: {
              source: 'override',
              request: {
                worktree: { kind: 'create', branch, fromRef: baseBranch },
                surface: { kind: 'create', title: 'Adopted' },
              },
              baseCommit: preflight.commit,
              checkoutPath: preflight.checkoutPath,
            },
            claim: {
              owner: OWNER,
              ownerIncarnation: INCARNATION,
              input: { value: { segment: 'environment_preparation' } },
            },
          });
          assert.equal(created.ok, true);
          if (!created.ok) throw new Error('unreachable');
          const runId = created.value.run.id;

          /**
           * The interruption itself, staged the only way it really happens.
           *
           * `git worktree add` run directly leaves exactly what a process killed mid-`openWorktree`
           * leaves: a checkout Git holds, and no row in Isagi naming it. Nothing reconciled, so
           * nothing recorded — which is the state the whole predicate exists to judge.
           */
          git.git(['worktree', 'add', '-b', branch, preflight.checkoutPath, preflight.commit]);
          assert.equal(
            yield* workspace.findProjectWorktreeByBranch({ projectId, branch }),
            null,
            'the interrupted attempt left a checkout with no row of its own',
          );

          // The crash's other residue: a claimed attempt nobody closed, failed at startup recovery.
          const failed = yield* fixtures.runs.failSegment({
            runId,
            attemptId: created.value.attempt.id,
            owner: OWNER,
            ownerIncarnation: INCARNATION,
            code: 'environment_preparation_failed',
            message: 'interrupted',
          });
          assert.equal(failed.ok, true);

          // Retry, through the same transactions the control performs at this position.
          const beforeRetry = (yield* fixtures.runs.findRun(runId))!;
          const pinned = yield* fixtures.runs.adoptRetryPin({
            runId,
            controlRevision: beforeRetry.controlRevision,
            artifactHash: ARTIFACT_HASH,
            expectedPosition: beforeRetry.position,
            expectedOwner: null,
          });
          assert.equal(pinned.ok, true);
          const repinned = (yield* fixtures.runs.findRun(runId))!;
          const claimed = yield* fixtures.runs.claimSegment({
            runId,
            controlRevision: repinned.controlRevision,
            owner: OWNER,
            ownerIncarnation: INCARNATION,
            input: { value: { segment: 'environment_preparation', receipts: {} } },
            preparation: {
              position: repinned.position,
              artifactHash: ARTIFACT_HASH,
              frameStates: [],
            },
          });
          assert.equal(claimed.ok, true);
          if (!claimed.ok) throw new Error('unreachable');
          assert.equal(claimed.value.attempt.invocationKind, 'retry');

          const deps: PreparationDeps = {
            runs: fixtures.runs,
            workspace,
            workspaceService: service,
            surfaceRepository: { findSurface: surfaceRows.find } as never,
            surfaces: { createSinglePaneSurface: surfaceRows.create } as never,
            owner: OWNER,
            ownerIncarnation: INCARNATION,
            poke: Effect.void,
          };
          const outcome = yield* prepareEnvironment(deps, {
            run: claimed.value.run,
            attempt: claimed.value.attempt,
          });

          assert.deepEqual(outcome, { kind: 'advanced' });

          const prep = (yield* fixtures.runs.findPreparation(runId))!;
          assert.equal(
            prep.worktree?.acquisition,
            'adopted_after_interruption',
            'the receipt says the run adopted it, never that this attempt created it',
          );
          assert.equal(prep.worktree?.worktreePath, preflight.checkoutPath);
          assert.equal(prep.worktree?.branch, branch);

          // The row the predicate judged was written by the retry's own reconcile, inside
          // `openWorktree`, before its collision checks. Without that ordering there would have been
          // nothing to adopt and the run could never have got past this branch.
          const adopted = (yield* workspace.findProjectWorktreeByBranch({ projectId, branch }))!;
          assert.equal(adopted.id, prep.worktree?.worktreeId);
          assert.equal(adopted.path, preflight.checkoutPath);

          /**
           * The two timestamps the predicate compares, checked as data as well as by outcome.
           *
           * Adoption already proves `firstSeenAt >= createdAt` held. Asserting the format as well is
           * what stops a future change to either writer from making that comparison meaningless
           * while every test still passes.
           */
          const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
          assert.match(adopted.firstSeenAt, iso);
          assert.match(prep.createdAt, iso);
          assert.ok(adopted.firstSeenAt >= prep.createdAt);

          // Setup re-ran because the adoption receipt said nobody had observed whether it had. The
          // project configures no hooks, so the honest answer it ends on is `skipped`.
          assert.equal(prep.setup?.status, 'skipped');
          assert.equal(prep.setup?.reason, 'not_configured');
          assert.deepEqual(
            postCreate,
            [adopted.id],
            'and it ran against the adopted checkout, not against some worktree it created',
          );

          // Exactly one checkout for this branch, and the run is placed in it.
          const worktrees = (yield* workspace.listWorktrees).filter(
            (worktree) => worktree.projectId === projectId,
          );
          assert.equal(worktrees.filter((worktree) => worktree.branch === branch).length, 1);
          const placed = (yield* fixtures.runs.findRun(runId))!;
          assert.equal(placed.position.kind, 'graph_entry');
          assert.deepEqual(placed.destination, {
            worktreeId: adopted.id,
            worktreePath: preflight.checkoutPath,
            surfaceId: prep.surface!.surfaceId,
          });
        }),
    );
  } finally {
    if (payloadRoot) rmSync(payloadRoot, { recursive: true, force: true });
    git.cleanup();
  }
});
