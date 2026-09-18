import assert from 'node:assert/strict';
import test from 'node:test';

import {
  complete,
  createGraph,
  defineWorkflow,
  edge,
  operation,
  outcome,
  reduce,
  type WorkflowEnvironmentContext,
  type WorkflowPlacementRequest,
} from '@yourtechbudstudio/isagi-workflow-sdk';
import { Cause, Effect, Exit, Option } from 'effect';

import { WorkspaceError } from '../../../workspace/workspace.service.js';
import { run } from '../../persistence/test-support.js';
import type { AnyWorkflowDefinition } from '../../structure/loader.js';
import { WorkflowEngineError } from '../../types.js';
import { makeEngineHarness, type EngineHarness } from '../test-support.js';

/**
 * Where a run is placed, decided and then checked — before anything exists to clean up.
 *
 * Two promises are under test and they are **not** the same promise, which is why almost every case
 * here asserts both. The first is that a refused launch leaves no row: no run, no preparation
 * record, no attempt. The second is that it *allocated* nothing — no worktree created, no setup
 * hooks run, no surface made. A launch could satisfy either one while violating the other, and
 * acceptance criterion 1 needs both, so the owning-service call log is asserted alongside the tables
 * rather than instead of them.
 *
 * The worktree-creation preflight is a double here. Phase 04 verified it against a real Git fixture
 * across fourteen cases; what is under test in this file is the *mapping* from its `WorkspaceError`
 * codes onto workflow rejections and their identities, which a tagged-error double exercises
 * directly. Everything else — projects, worktrees, surfaces, attachments — is real rows in the real
 * schema.
 */

async function withHarness(body: (harness: EngineHarness) => Promise<void>) {
  const harness = await makeEngineHarness();
  try {
    await body(harness);
  } finally {
    await harness.close();
  }
}

interface WorkflowOptions {
  readonly environment?:
    | ((ctx: WorkflowEnvironmentContext, inputs: Record<string, unknown>) => unknown)
    | undefined;
}

function workflowWith(options: WorkflowOptions = {}): AnyWorkflowDefinition {
  const graph = createGraph<{ readonly rounds: number }, {}, Record<string, unknown>>({
    key: 'placeable',
    title: 'Placeable',
    init: () => ({ rounds: 0 }),
    state: { rounds: reduce.add() },
    entry: 'work',
    nodes: { work: operation(async () => complete({ update: { rounds: 1 } })) },
    edges: {
      'work-out': edge({ from: 'work', to: ['finished'], choose: () => ({ to: 'finished' }) }),
    },
    outcomes: { finished: outcome({ kind: 'success', output: () => ({}) }) },
  });
  return defineWorkflow({
    command: () => ({ title: 'Placeable' }),
    validate: () => {},
    ...(options.environment
      ? {
          environment: options.environment as (
            ctx: WorkflowEnvironmentContext,
            inputs: Record<string, unknown>,
          ) => WorkflowPlacementRequest,
        }
      : {}),
    graph,
  }) as AnyWorkflowDefinition;
}

function rejectionOf(exit: Exit.Exit<unknown, unknown>): WorkflowEngineError {
  assert.equal(exit._tag, 'Failure', 'expected the launch to be refused');
  if (exit._tag !== 'Failure') throw new Error('unreachable');
  const failure = Option.getOrNull(Cause.failureOption(exit.cause));
  assert.ok(
    failure instanceof WorkflowEngineError,
    `expected a WorkflowEngineError, got ${Cause.pretty(exit.cause)}`,
  );
  return failure;
}

/**
 * Nothing was written, and nothing was allocated.
 *
 * "No run row" and "nothing was created out in the world" are separate claims: a launch that
 * created a worktree and then failed to insert its run would satisfy the first and fail the second,
 * and that is precisely the state this story exists to make impossible before a run row exists.
 */
async function assertRefusedCleanly(harness: EngineHarness, expectedCalls: readonly string[] = []) {
  const counts = harness.fixture.client
    .prepare(
      `SELECT
         (SELECT count(*) FROM workflow_runs) AS runs,
         (SELECT count(*) FROM workflow_run_preparations) AS preparations,
         (SELECT count(*) FROM workflow_segment_attempts) AS attempts,
         (SELECT count(*) FROM workflow_run_attachments) AS attachments`,
    )
    .get() as Record<string, number>;
  assert.deepEqual(counts, { runs: 0, preparations: 0, attempts: 0, attachments: 0 });
  assert.deepEqual(
    harness.owning.calls,
    [...expectedCalls],
    'a refused launch allocates nothing; only the read-only preflight may be called',
  );
}

/**
 * The same two claims, for a refusal that follows an accepted launch.
 *
 * `assertRefusedCleanly` asserts absolute zeros, which only holds while nothing has been launched
 * yet. Several rows of the table are only reachable *after* a run exists — a surface is busy because
 * something took it, and a placement is incompatible with a worktree some other run is already on —
 * so those cases need the delta instead: whatever the tables and the call log held before the
 * refusal, they hold after it.
 */
async function assertRefusalChangedNothing(
  harness: EngineHarness,
  body: () => Promise<Exit.Exit<unknown, unknown>>,
  expectedCalls: readonly string[] = [],
): Promise<WorkflowEngineError> {
  const snapshot = () =>
    harness.fixture.client
      .prepare(
        `SELECT
           (SELECT count(*) FROM workflow_runs) AS runs,
           (SELECT count(*) FROM workflow_run_preparations) AS preparations,
           (SELECT count(*) FROM workflow_segment_attempts) AS attempts,
           (SELECT count(*) FROM workflow_run_attachments) AS attachments`,
      )
      .get() as Record<string, number>;

  const before = snapshot();
  const callsBefore = [...harness.owning.calls];
  const failure = rejectionOf(await body());
  assert.deepEqual(snapshot(), before, 'a refused launch writes no row of its own');
  assert.deepEqual(
    harness.owning.calls,
    [...callsBefore, ...expectedCalls],
    'and allocates nothing: only the read-only preflight may be called',
  );
  return failure;
}

/** A second worktree and surface inside the harness placement's own project. */
function seedSibling(harness: EngineHarness, suffix: string) {
  const client = harness.fixture.client;
  const { projectId } = client
    .prepare('SELECT project_id AS projectId FROM worktrees WHERE id = ?')
    .get(harness.placement.worktreeId) as { projectId: number };
  const worktree = client
    .prepare(
      `INSERT INTO worktrees (project_id, path, branch, head, sort_order, created_at, updated_at, first_seen_at)
       VALUES (?, ?, ?, NULL, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .run(projectId, `/repo/fixture-${suffix}`, suffix);
  const surface = client
    .prepare(
      `INSERT INTO worktree_surfaces (worktree_id, title, layout_json, sort_order, created_at, updated_at)
       VALUES (?, ?, '{}', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .run(worktree.lastInsertRowid, `Surface ${suffix}`);
  return {
    projectId,
    worktreeId: Number(worktree.lastInsertRowid),
    surfaceId: Number(surface.lastInsertRowid),
  };
}

function preparationRow(harness: EngineHarness, runId: number) {
  const row = harness.fixture.client
    .prepare(
      'SELECT source, request_json AS requestJson, base_commit AS baseCommit, checkout_path AS checkoutPath FROM workflow_run_preparations WHERE run_id = ?',
    )
    .get(runId) as
    | {
        source: string;
        requestJson: string;
        baseCommit: string | null;
        checkoutPath: string | null;
      }
    | undefined;
  assert.ok(row, `run ${runId} has no preparation record`);
  return { ...row, request: JSON.parse(row.requestJson) as unknown };
}

/** Fail the preflight with one workspace code, as the real service would. */
function preflightFails(
  harness: EngineHarness,
  error: ConstructorParameters<typeof WorkspaceError>[0],
) {
  harness.owning.setPreflight(() => Effect.fail(new WorkspaceError(error)));
}

// --- the three sources ------------------------------------------------------------------------

test('with no hook and no override the placement is the unchanged current/current default', async () => {
  await withHarness(async (harness) => {
    harness.publish({ workflowKey: 'placeable', version: '1', definition: workflowWith() });

    const launched = await harness.launch({ workflowKey: 'placeable' });

    const prep = preparationRow(harness, launched.id);
    assert.equal(prep.source, 'default');
    assert.deepEqual(prep.request, {
      worktree: { kind: 'current' },
      surface: { kind: 'current' },
    });
    assert.deepEqual(
      [prep.baseCommit, prep.checkoutPath],
      [null, null],
      'nothing is created, so there is no commit and no checkout path to record',
    );
    assert.deepEqual(harness.owning.calls, [], 'and the preflight is not consulted at all');
    assert.deepEqual(launched.destination, {
      worktreeId: harness.placement.worktreeId,
      worktreePath: '/repo/fixture',
      surfaceId: harness.placement.surfaceId,
    });

    // The claimed attempt records the whole decision, not just the segment name: an attempt has to
    // be able to say what it was about to do even once every row it names is gone.
    const attempts = await run(harness.fixture.runs.listAttemptsForFrame(launched.activeFrameId!));
    const preparation = attempts.find(
      (attempt) => attempt.segmentKind === 'environment_preparation',
    );
    assert.ok(preparation, 'the run was created with its preparation attempt already claimed');
    assert.deepEqual(await run(harness.fixture.payloads.resolve(preparation.input!)), {
      segment: 'environment_preparation',
      source: 'default',
      request: { worktree: { kind: 'current' }, surface: { kind: 'current' } },
      baseCommit: null,
      checkoutPath: null,
    });
  });
});

test("the author's hook decides, is called once, and sees only this project", async () => {
  await withHarness(async (harness) => {
    const sibling = seedSibling(harness, 'feature');
    const other = harness.seedPlacement();
    const seen: {
      calls: number;
      worktrees: readonly unknown[];
      surfaces: readonly unknown[];
      project: unknown;
    } = { calls: 0, worktrees: [], surfaces: [], project: null };

    harness.publish({
      workflowKey: 'placeable',
      version: '1',
      definition: workflowWith({
        environment: async (ctx) => {
          seen.calls += 1;
          seen.project = ctx.project;
          seen.worktrees = await ctx.listWorktrees();
          seen.surfaces = await ctx.listSurfaces({ worktreeId: sibling.worktreeId });
          return {
            worktree: { kind: 'existing', worktreeId: sibling.worktreeId },
            surface: { kind: 'existing', surfaceId: sibling.surfaceId },
          };
        },
      }),
    });

    const launched = await harness.launch({ workflowKey: 'placeable' });

    assert.equal(seen.calls, 1, 'the hook is called exactly once per launch');
    assert.deepEqual(seen.project, { id: sibling.projectId, name: 'fixture', kind: 'git' });
    assert.deepEqual(
      (seen.worktrees as { id: number }[]).map((worktree) => worktree.id).sort((a, b) => a - b),
      [harness.placement.worktreeId, sibling.worktreeId].sort((a, b) => a - b),
      'project-scoped: the other project’s worktree is not listed',
    );
    assert.ok(
      !(seen.worktrees as { id: number }[]).some((worktree) => worktree.id === other.worktreeId),
    );
    assert.deepEqual(seen.surfaces, [
      { id: sibling.surfaceId, worktreeId: sibling.worktreeId, title: 'Surface feature' },
    ]);

    const prep = preparationRow(harness, launched.id);
    assert.equal(prep.source, 'selector');
    assert.deepEqual(launched.destination, {
      worktreeId: sibling.worktreeId,
      worktreePath: '/repo/fixture-feature',
      surfaceId: sibling.surfaceId,
    });
  });
});

test('isRoot marks the worktree checked out at the project root, and nothing else', async () => {
  await withHarness(async (harness) => {
    const sibling = seedSibling(harness, 'branchy');
    let listed: readonly { id: number; isRoot: boolean; branch: string | null }[] = [];
    harness.publish({
      workflowKey: 'placeable',
      version: '1',
      definition: workflowWith({
        environment: async (ctx) => {
          listed = (await ctx.listWorktrees()) as typeof listed;
          return { worktree: { kind: 'current' }, surface: { kind: 'current' } };
        },
      }),
    });

    await harness.launch({ workflowKey: 'placeable' });

    assert.deepEqual(
      listed.map((worktree) => [worktree.id, worktree.isRoot, worktree.branch]),
      [
        [harness.placement.worktreeId, true, 'main'],
        [sibling.worktreeId, false, 'branchy'],
      ],
    );
  });
});

test('a caller override wins, and the hook is never called', async () => {
  await withHarness(async (harness) => {
    const sibling = seedSibling(harness, 'override');
    let hookCalls = 0;
    harness.publish({
      workflowKey: 'placeable',
      version: '1',
      definition: workflowWith({
        environment: () => {
          hookCalls += 1;
          return { worktree: { kind: 'current' }, surface: { kind: 'current' } };
        },
      }),
    });

    const launched = await harness.launch({
      workflowKey: 'placeable',
      request: {
        worktree: { kind: 'existing', worktreeId: sibling.worktreeId },
        surface: { kind: 'existing', surfaceId: sibling.surfaceId },
      },
    });

    assert.equal(hookCalls, 0, 'an override the workflow could overrule would not be an override');
    const prep = preparationRow(harness, launched.id);
    assert.equal(prep.source, 'override');
    assert.deepEqual(prep.request, {
      worktree: { kind: 'existing', worktreeId: sibling.worktreeId },
      surface: { kind: 'existing', surfaceId: sibling.surfaceId },
    });
    assert.equal(launched.destination.surfaceId, sibling.surfaceId);
  });
});

test('a hook that throws and a hook that returns nonsense are the same rejection', async () => {
  await withHarness(async (harness) => {
    harness.publish({
      workflowKey: 'thrower',
      version: '1',
      definition: workflowWith({
        environment: () => {
          throw new Error('I have no idea where this should run');
        },
      }),
    });

    const thrown = rejectionOf(await harness.launchExit({ workflowKey: 'thrower' }));
    assert.equal(thrown.code, 'workflow_environment_selection_failed');
    assert.match(thrown.message, /no idea where this should run/);
    await assertRefusedCleanly(harness);

    harness.publish({
      workflowKey: 'malformed',
      version: '1',
      // A shape the placement schema refuses: rejected at the launch boundary rather than deep
      // inside preparation with a run row already behind it.
      definition: workflowWith({ environment: () => ({ worktree: { kind: 'somewhere' } }) }),
    });

    const malformed = rejectionOf(await harness.launchExit({ workflowKey: 'malformed' }));
    assert.equal(malformed.code, 'workflow_environment_selection_failed');
    await assertRefusedCleanly(harness);
  });
});

test('a context retained past the hook is closed, not a handle on the database', async () => {
  await withHarness(async (harness) => {
    let retained: WorkflowEnvironmentContext | null = null;
    harness.publish({
      workflowKey: 'placeable',
      version: '1',
      definition: workflowWith({
        environment: (ctx) => {
          retained = ctx;
          return { worktree: { kind: 'current' }, surface: { kind: 'current' } };
        },
      }),
    });

    await harness.launch({ workflowKey: 'placeable' });

    const ctx = retained as unknown as WorkflowEnvironmentContext;
    await assert.rejects(
      () => ctx.listWorktrees(),
      /The environment context is closed once environment\(\) has returned\./,
    );
    await assert.rejects(
      () => ctx.listSurfaces({ worktreeId: harness.placement.worktreeId }),
      /The environment context is closed once environment\(\) has returned\./,
    );
  });
});

test('listSurfaces refuses a worktree outside the launch project', async () => {
  await withHarness(async (harness) => {
    const other = harness.seedPlacement();
    let rejected: string | null = null;
    harness.publish({
      workflowKey: 'placeable',
      version: '1',
      definition: workflowWith({
        environment: async (ctx) => {
          try {
            await ctx.listSurfaces({ worktreeId: other.worktreeId });
          } catch (cause) {
            rejected = (cause as Error).message;
          }
          return { worktree: { kind: 'current' }, surface: { kind: 'current' } };
        },
      }),
    });

    await harness.launch({ workflowKey: 'placeable' });
    assert.equal(rejected, `Worktree ${other.worktreeId} is not in this project.`);
  });
});

test('an override that is not a placement is refused as an invalid placement', async () => {
  await withHarness(async (harness) => {
    harness.publish({ workflowKey: 'placeable', version: '1', definition: workflowWith() });

    const failure = rejectionOf(
      await harness.launchExit({
        workflowKey: 'placeable',
        request: { worktree: { kind: 'current' } } as never,
      }),
    );
    assert.equal(failure.code, 'workflow_placement_invalid');
    await assertRefusedCleanly(harness);
  });
});

// --- the rejection table ----------------------------------------------------------------------

test('an existing worktree must exist, and must be in the launch project', async () => {
  await withHarness(async (harness) => {
    harness.publish({ workflowKey: 'placeable', version: '1', definition: workflowWith() });
    const other = harness.seedPlacement();

    const missing = rejectionOf(
      await harness.launchExit({
        workflowKey: 'placeable',
        request: { worktree: { kind: 'existing', worktreeId: 9999 }, surface: { kind: 'current' } },
      }),
    );
    assert.equal(missing.code, 'worktree_not_found');
    assert.equal(missing.worktreeId, 9999);
    await assertRefusedCleanly(harness);

    const elsewhere = rejectionOf(
      await harness.launchExit({
        workflowKey: 'placeable',
        request: {
          worktree: { kind: 'existing', worktreeId: other.worktreeId },
          surface: { kind: 'current' },
        },
      }),
    );
    assert.equal(elsewhere.code, 'workflow_placement_invalid');
    assert.equal(elsewhere.placementIssue, 'worktree_not_in_project');
    assert.equal(elsewhere.worktreeId, other.worktreeId);
    await assertRefusedCleanly(harness);
  });
});

test('every worktree-creation refusal maps to its own reason and carries its identities', async () => {
  const cases = [
    {
      name: 'a folder project has no worktrees to create',
      error: { code: 'worktrees_not_supported' as const, message: 'folder project' },
      expect: (failure: WorkflowEngineError) => {
        assert.equal(failure.code, 'workflow_worktree_creation_unsupported');
        assert.ok(failure.projectId);
      },
    },
    {
      name: 'a branch name Git refuses',
      error: { code: 'invalid_branch_name' as const, message: 'bad branch', branch: 'feat/..bad' },
      expect: (failure: WorkflowEngineError) => {
        assert.equal(failure.code, 'workflow_branch_invalid');
        assert.equal(failure.branch, 'feat/new');
      },
    },
    {
      name: 'a base ref that resolves to nothing',
      error: { code: 'base_ref_not_found' as const, message: 'no such ref' },
      expect: (failure: WorkflowEngineError) => {
        assert.equal(failure.code, 'workflow_base_ref_not_found');
        assert.equal(failure.baseRef, 'origin/main');
        // The pair, not just the ref: architecture §4.3's table requires both, because which half
        // of the request to change is not answerable from the ref alone.
        assert.equal(failure.branch, 'feat/new');
      },
    },
    {
      name: 'a branch that already exists',
      error: { code: 'branch_exists' as const, message: 'branch exists', branch: 'feat/new' },
      expect: (failure: WorkflowEngineError) => {
        assert.equal(failure.code, 'workflow_environment_collision');
        assert.equal(failure.collision, 'branch');
        assert.equal(failure.branch, 'feat/new');
      },
    },
    {
      name: 'a stale worktree row on that branch',
      error: {
        code: 'worktree_exists' as const,
        message: 'worktree exists',
        branch: 'feat/new',
        worktreeId: 77,
      },
      expect: (failure: WorkflowEngineError) => {
        assert.equal(failure.code, 'workflow_environment_collision');
        assert.equal(failure.collision, 'worktree');
        assert.equal(failure.worktreeId, 77);
      },
    },
    {
      name: 'a checkout path already taken',
      error: { code: 'checkout_path_exists' as const, message: 'path exists' },
      expect: (failure: WorkflowEngineError) => {
        assert.equal(failure.code, 'workflow_environment_collision');
        assert.equal(failure.collision, 'checkout_path');
      },
    },
    {
      name: 'a checkout path registered to another worktree',
      error: { code: 'checkout_path_registered' as const, message: 'path registered' },
      expect: (failure: WorkflowEngineError) => {
        assert.equal(failure.code, 'workflow_environment_collision');
        assert.equal(failure.collision, 'checkout_path');
      },
    },
    {
      name: 'a project that has gone',
      error: { code: 'project_not_present' as const, message: 'project missing' },
      expect: (failure: WorkflowEngineError) => {
        assert.equal(failure.code, 'worktree_not_found');
      },
    },
  ];

  for (const testCase of cases) {
    await withHarness(async (harness) => {
      harness.publish({ workflowKey: 'placeable', version: '1', definition: workflowWith() });
      preflightFails(harness, testCase.error);

      const failure = rejectionOf(
        await harness.launchExit({
          workflowKey: 'placeable',
          request: {
            worktree: { kind: 'create', branch: 'feat/new', fromRef: 'origin/main' },
            surface: { kind: 'create', title: 'New work' },
          },
        }),
      );
      testCase.expect(failure);
      // The preflight is the *only* call: it allocates nothing, and nothing past it was reached.
      await assertRefusedCleanly(harness, ['preflightWorktreeCreation']);
    });
  }
});

test('the surface must be on the worktree the run resolved to', async () => {
  await withHarness(async (harness) => {
    harness.publish({ workflowKey: 'placeable', version: '1', definition: workflowWith() });
    const sibling = seedSibling(harness, 'sibling');

    // `current` naming the origin worktree through `existing` still passes: compatibility is
    // membership, not kind.
    const accepted = await harness.launch({
      workflowKey: 'placeable',
      request: {
        worktree: { kind: 'existing', worktreeId: harness.placement.worktreeId },
        surface: { kind: 'current' },
      },
    });
    assert.equal(accepted.destination.surfaceId, harness.placement.surfaceId);

    // Both refusals below land at the surface step, before occupancy is ever consulted, so the
    // accepted run still holding the origin surface is not what makes them fail.
    const elsewhere = await assertRefusalChangedNothing(harness, () =>
      harness.launchExit({
        workflowKey: 'placeable',
        request: {
          worktree: { kind: 'existing', worktreeId: sibling.worktreeId },
          surface: { kind: 'current' },
        },
      }),
    );
    assert.equal(elsewhere.code, 'workflow_placement_invalid');
    assert.equal(elsewhere.placementIssue, 'surface_not_on_worktree');

    // A worktree that does not exist yet can never host the current surface — and this is the one
    // row where an owning service is genuinely consulted and *still* nothing is allocated. The
    // preflight succeeds, the surface step then refuses, and the two claims criterion 1 makes come
    // apart: there is no run row, and there is no worktree either.
    const created = await assertRefusalChangedNothing(
      harness,
      () =>
        harness.launchExit({
          workflowKey: 'placeable',
          request: {
            worktree: { kind: 'create', branch: 'feat/new', fromRef: 'main' },
            surface: { kind: 'current' },
          },
        }),
      ['preflightWorktreeCreation'],
    );
    assert.equal(created.code, 'workflow_placement_invalid');
    assert.equal(created.placementIssue, 'surface_not_on_worktree');
  });
});

test('an existing surface must exist and must sit on the resolved worktree', async () => {
  await withHarness(async (harness) => {
    harness.publish({ workflowKey: 'placeable', version: '1', definition: workflowWith() });
    const sibling = seedSibling(harness, 'sibling');

    const missing = rejectionOf(
      await harness.launchExit({
        workflowKey: 'placeable',
        request: { worktree: { kind: 'current' }, surface: { kind: 'existing', surfaceId: 9999 } },
      }),
    );
    assert.equal(missing.code, 'surface_not_found');
    assert.equal(missing.surfaceId, 9999);
    await assertRefusedCleanly(harness);

    const wrongWorktree = rejectionOf(
      await harness.launchExit({
        workflowKey: 'placeable',
        request: {
          worktree: { kind: 'current' },
          surface: { kind: 'existing', surfaceId: sibling.surfaceId },
        },
      }),
    );
    assert.equal(wrongWorktree.code, 'workflow_placement_invalid');
    assert.equal(wrongWorktree.placementIssue, 'surface_not_on_worktree');
    await assertRefusedCleanly(harness);
  });
});

test('a surface title is refused by the surfaces domain rule, not a second copy of it', async () => {
  await withHarness(async (harness) => {
    harness.publish({ workflowKey: 'placeable', version: '1', definition: workflowWith() });

    const failure = rejectionOf(
      await harness.launchExit({
        workflowKey: 'placeable',
        request: { worktree: { kind: 'current' }, surface: { kind: 'create', title: '   ' } },
      }),
    );
    assert.equal(failure.code, 'workflow_placement_invalid');
    assert.equal(failure.placementIssue, 'invalid_surface_title');
    assert.match(failure.message, /between 1 and 80 characters/);
    await assertRefusedCleanly(harness);
  });
});

test('occupancy is checked on the destination, so a busy origin no longer blocks a launch elsewhere', async () => {
  await withHarness(async (harness) => {
    harness.publish({ workflowKey: 'placeable', version: '1', definition: workflowWith() });
    const sibling = seedSibling(harness, 'destination');

    // The origin surface is occupied by a run of its own.
    const first = await harness.launch({ workflowKey: 'placeable' });
    assert.equal(first.destination.surfaceId, harness.placement.surfaceId);

    // Headed somewhere else, and therefore accepted. This is the behaviour change the story exists
    // for: before this, the origin surface's occupant refused every launch from it.
    const second = await harness.launch({
      workflowKey: 'placeable',
      request: {
        worktree: { kind: 'existing', worktreeId: sibling.worktreeId },
        surface: { kind: 'existing', surfaceId: sibling.surfaceId },
      },
    });
    assert.equal(second.destination.surfaceId, sibling.surfaceId);

    // The destination being busy still refuses, and before any row is written.
    const busy = await assertRefusalChangedNothing(harness, () =>
      harness.launchExit({
        workflowKey: 'placeable',
        request: {
          worktree: { kind: 'existing', worktreeId: sibling.worktreeId },
          surface: { kind: 'existing', surfaceId: sibling.surfaceId },
        },
      }),
    );
    assert.equal(busy.code, 'workflow_surface_attached');
    assert.equal(busy.activeWorkflowRunId, second.id);
    assert.equal(busy.surfaceId, sibling.surfaceId);
    assert.equal(
      busy.workflowRunId,
      undefined,
      'refused before a run existed, so there is no retained run to hand back',
    );
  });
});
