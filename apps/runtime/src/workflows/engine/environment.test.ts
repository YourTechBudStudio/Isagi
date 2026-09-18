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
} from '@yourtechbudstudio/isagi-workflow-sdk';
import { Effect } from 'effect';

import { GitCommandError } from '../../git/index.js';
import { WorktreeSetupError } from '../../worktree-setup/index.js';
import { firstIncompleteStep } from '../persistence/preparations.js';
import { run } from '../persistence/test-support.js';
import type { AnyWorkflowDefinition } from '../structure/loader.js';
import type { WorkflowDestination } from '../types.js';
import { surfaceCreationKey } from './environment/preparation.js';
import {
  createBoth,
  derivedCheckoutPath,
  makeEngineHarness,
  seedWorktreeRow,
  type EngineHarness,
} from './test-support.js';

/**
 * Preparation: the segment that brings a run's chosen environment into existence.
 *
 * Every case here turns on the same two facts, so they are worth stating once rather than
 * re-deriving them per test.
 *
 * **A receipt means "this launch allocated this."** Reuse writes none, because there is nothing to
 * record and nothing a later attempt would have to avoid duplicating. That is why a re-entry can
 * tell "create it now" apart from "the worktree you already made is over there", and why a failure
 * can name exactly the resources this run brought into the world.
 *
 * **Nothing is ever deleted.** Not on a setup failure, not on a busy commit, not on a collision.
 * Setup hooks may already have written files somebody wants. Every failure case below therefore
 * asserts the rows and the owning-service deletion log, not just the failure.
 *
 * The owning services are doubles that write **real rows** — a created worktree is a row
 * `findWorktree` finds, a keyed surface resolves through the real `creation_key` column — because
 * every rule here is about what a second attempt sees. Their real-Git behaviour is phase 04's
 * evidence; the one thing a double genuinely cannot show, adoption of a checkout left by an
 * interrupted attempt, has its own live-Git test in
 * [`environment/adoption.live-git.test.ts`](./environment/adoption.live-git.test.ts).
 */

async function withHarness(body: (harness: EngineHarness) => Promise<void>) {
  const harness = await makeEngineHarness();
  try {
    await body(harness);
  } finally {
    await harness.close();
  }
}

interface Counters {
  command: number;
  validate: number;
  init: number;
  destinations: WorkflowDestination[];
}

function counters(): Counters {
  return { command: 0, validate: 0, init: 0, destinations: [] };
}

/** A workflow that records the destination its graph was initialized against. */
function placeableWorkflow(seen: Counters): AnyWorkflowDefinition {
  const graph = createGraph<{ readonly rounds: number }, {}, Record<string, unknown>>({
    key: 'placeable',
    title: 'Placeable',
    init: (destination) => {
      seen.init += 1;
      seen.destinations.push(destination as WorkflowDestination);
      return { rounds: 0 };
    },
    state: { rounds: reduce.add() },
    entry: 'work',
    nodes: { work: operation(async () => complete({ update: { rounds: 1 } })) },
    edges: {
      'work-out': edge({ from: 'work', to: ['finished'], choose: () => ({ to: 'finished' }) }),
    },
    outcomes: { finished: outcome({ kind: 'success', output: () => ({}) }) },
  });
  return defineWorkflow({
    command: () => {
      seen.command += 1;
      return { title: 'Placeable' };
    },
    validate: () => {
      seen.validate += 1;
    },
    graph,
  }) as AnyWorkflowDefinition;
}

function publish(harness: EngineHarness, seen: Counters) {
  harness.publish({ workflowKey: 'placeable', version: '1', definition: placeableWorkflow(seen) });
}

function transitionKinds(harness: EngineHarness, runId: number): string[] {
  return (
    harness.fixture.client
      .prepare('SELECT kind FROM workflow_transitions WHERE run_id = ? ORDER BY revision')
      .all(runId) as { kind: string }[]
  ).map((row) => row.kind);
}

function worktreeRows(harness: EngineHarness): { id: number; path: string; branch: string }[] {
  return harness.fixture.client
    .prepare('SELECT id, path, branch FROM worktrees ORDER BY id')
    .all() as { id: number; path: string; branch: string }[];
}

function surfaceRows(harness: EngineHarness): { id: number; worktreeId: number; title: string }[] {
  return harness.fixture.client
    .prepare('SELECT id, worktree_id AS worktreeId, title FROM worktree_surfaces ORDER BY id')
    .all() as { id: number; worktreeId: number; title: string }[];
}

async function failureDetailOf(harness: EngineHarness, runId: number) {
  const failed = await harness.runOf(runId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failureCode, 'environment_preparation_failed');
  const attempt = (await run(harness.fixture.runs.findAttempt(failed.failureAttemptId!)))!;
  return (await run(harness.fixture.payloads.resolve(attempt.failureDetail!))) as Record<
    string,
    unknown
  >;
}

test('a default launch reuses its origin, writes no receipt, and initializes against the destination', async () => {
  await withHarness(async (harness) => {
    const seen = counters();
    publish(harness, seen);

    const started = await harness.launch({ workflowKey: 'placeable' });
    await harness.drain();

    const placed = await harness.runOf(started.id);
    assert.deepEqual(placed.destination, {
      worktreeId: harness.placement.worktreeId,
      worktreePath: harness.fixture.worktreeDirectory,
      surfaceId: harness.placement.surfaceId,
    });
    assert.ok(await run(harness.fixture.runs.findAttachment(started.id)));

    /**
     * Reuse allocates nothing, so there is nothing to record.
     *
     * All three receipt columns null is the load-bearing assertion, not a tidiness one: it is what
     * makes `preparation.worktree` mean "this launch created a worktree" rather than "this run has
     * a worktree", which every re-entry decision below depends on.
     */
    const prep = (await harness.preparationOf(started.id))!;
    assert.equal(prep.source, 'default');
    assert.deepEqual([prep.worktree, prep.setup, prep.surface], [null, null, null]);
    assert.deepEqual([prep.baseCommit, prep.checkoutPath], [null, null]);
    assert.equal(firstIncompleteStep(prep), 'commit');

    // Two workflow transactions, seen through what each one wrote: `createRun` emitted the start
    // and the dispatch, the commit emitted the preparation. No step was recorded, because no step
    // allocated anything.
    assert.deepEqual(transitionKinds(harness, started.id).slice(0, 3), [
      'run_started',
      'node_dispatched',
      'environment_prepared',
    ]);
    assert.equal(
      transitionKinds(harness, started.id).filter((kind) => kind === 'environment_step_recorded')
        .length,
      0,
    );
    assert.deepEqual(harness.owning.calls, [], 'a reuse placement consults no owning service');

    // `init` ran once, after the commit, against the effective destination — never the origin by
    // coincidence, which is why the surface id is asserted rather than only the worktree.
    assert.equal(seen.init, 1);
    assert.deepEqual(seen.destinations, [
      {
        worktreeId: harness.placement.worktreeId,
        worktreePath: harness.fixture.worktreeDirectory,
        surfaceId: harness.placement.surfaceId,
      },
    ]);
    assert.deepEqual([seen.command, seen.validate], [1, 1]);
  });
});

test('creating a worktree records what it created, and only after the owning service returns', async () => {
  await withHarness(async (harness) => {
    const seen = counters();
    publish(harness, seen);
    harness.owning.allowsWorktrees().allowsSurfaces();

    /**
     * What the preparation row looked like *while* the worktree was being created.
     *
     * The window matters: a receipt written before the allocation returned would name a worktree
     * that might not exist, and a retry reading it would reuse something that was never made.
     */
    let duringCreation: Record<string, unknown> | undefined;
    harness.owning.wrapOpenWorktree(
      (inner) => (input) =>
        Effect.suspend(() => {
          duringCreation = harness.fixture.client
            .prepare(
              `SELECT worktree_receipt_json AS worktree, setup_receipt_json AS setup,
                    surface_receipt_json AS surface
               FROM workflow_run_preparations WHERE run_id = 1`,
            )
            .get() as Record<string, unknown>;
          return inner(input);
        }),
    );

    const started = await harness.launch({
      workflowKey: 'placeable',
      request: createBoth('  feature/alpha  ', 'Alpha'),
    });

    assert.deepEqual(
      duringCreation,
      { worktree: null, setup: null, surface: null },
      'no receipt exists while the allocation is still in flight',
    );

    const prep = (await harness.preparationOf(started.id))!;
    // The branch was trimmed once, at validation, and everything downstream uses that one answer.
    assert.equal(prep.worktree?.acquisition, 'created');
    assert.equal(prep.worktree?.branch, 'feature/alpha');
    assert.equal(prep.setup?.status, 'skipped');
    assert.equal(prep.setup?.reason, 'not_configured');
    assert.equal(prep.surface?.requestedTitle, 'Alpha');
    assert.equal(prep.surface?.title, 'Alpha');
    assert.equal(prep.baseCommit, 'a'.repeat(40));
    assert.equal(prep.checkoutPath, derivedCheckoutPath(1, 'feature/alpha'));

    const placed = await harness.runOf(started.id);
    assert.equal(placed.position.kind, 'graph_entry');
    assert.deepEqual(placed.destination, {
      worktreeId: prep.worktree!.worktreeId,
      worktreePath: derivedCheckoutPath(1, 'feature/alpha'),
      surfaceId: prep.surface!.surfaceId,
    });

    await harness.drain();
    assert.deepEqual(seen.destinations, [
      {
        worktreeId: prep.worktree!.worktreeId,
        worktreePath: derivedCheckoutPath(1, 'feature/alpha'),
        surfaceId: prep.surface!.surfaceId,
      },
    ]);
  });
});

test('the preflight and the creation are both given the trimmed branch and the resolved commit', async () => {
  await withHarness(async (harness) => {
    publish(harness, counters());
    harness.owning.allowsWorktrees().allowsSurfaces();

    const preflights: unknown[] = [];
    harness.owning.setPreflight((input) => {
      preflights.push(input);
      return Effect.succeed({
        commit: 'b'.repeat(40),
        checkoutPath: derivedCheckoutPath(input.projectId, input.branch),
      });
    });
    const opens: unknown[] = [];
    harness.owning.wrapOpenWorktree((inner) => (input) => {
      opens.push(input);
      return inner(input);
    });

    await harness.launch({
      workflowKey: 'placeable',
      request: createBoth(' feature/beta ', 'Beta'),
    });

    assert.deepEqual(preflights, [{ projectId: 1, branch: 'feature/beta', fromRef: 'main' }]);
    // The commit, not the ref: `main` may have moved between the launch and the creation, and
    // criterion 7 wants the run's work to start from the commit the decision was recorded against.
    assert.deepEqual(opens, [
      {
        projectId: 1,
        request: {
          branch: 'feature/beta',
          base: { kind: 'commit', commit: 'b'.repeat(40) },
          mode: 'create_new',
        },
      },
    ]);
  });
});

test('setup that fails during creation keeps the worktree, and Retry re-runs only setup', async () => {
  await withHarness(async (harness) => {
    publish(harness, counters());
    harness.owning
      .allowsWorktrees({
        setup: {
          status: 'failed',
          runId: 7,
          failedHookIndex: 1,
          failedHookType: 'command',
          message: 'pnpm install failed',
          exitCode: 1,
          outputExcerpt: 'ERR_PNPM_NO_LOCKFILE',
        },
      })
      .allowsSurfaces();

    const started = await harness.launch({
      workflowKey: 'placeable',
      request: createBoth('feature/setup', 'Setup'),
    });

    const detail = await failureDetailOf(harness, started.id);
    assert.equal(detail.step, 'setup');
    assert.equal(detail.reason, 'setup_failed');
    assert.equal(detail.diagnostic, 'ERR_PNPM_NO_LOCKFILE');

    // The worktree it created is still there, named by a receipt, with its failed setup recorded.
    const failedPrep = (await harness.preparationOf(started.id))!;
    assert.equal(failedPrep.worktree?.acquisition, 'created');
    assert.equal(failedPrep.setup?.status, 'failed');
    assert.equal(failedPrep.setup?.failure?.message, 'pnpm install failed');
    assert.equal(firstIncompleteStep(failedPrep), 'setup');
    assert.equal(worktreeRows(harness).length, 2, 'and nothing was rolled back or deleted');
    assert.deepEqual(harness.owning.deletions, []);

    // Retry picks up exactly where the receipts say it should: hooks again, creation never.
    harness.owning.calls.length = 0;
    harness.owning.allowsSetup({ status: 'succeeded', runId: 8 });
    const retried = await harness.retry(started.id);

    assert.deepEqual(
      [retried.accepted, retried.status],
      [true, 'ready'],
      'the control accepted, and the run it hands back is dispatchable again',
    );
    assert.deepEqual(harness.owning.calls, ['runWorktreeSetup', 'createSinglePaneSurface']);
    const prep = (await harness.preparationOf(started.id))!;
    assert.equal(prep.setup?.status, 'succeeded');
    assert.equal(prep.setup?.setupRunId, 8);
    assert.equal(
      prep.worktree?.worktreeId,
      failedPrep.worktree?.worktreeId,
      'the same worktree, not a second one',
    );
    assert.equal(worktreeRows(harness).length, 2);
    assert.equal((await harness.runOf(started.id)).position.kind, 'graph_entry');
  });
});

/**
 * A chatty hook must not cost the whole failure detail, and this is where that is enforced.
 *
 * The detail goes through the payload store: above `inlinePayloadThresholdBytes` (8192) it is
 * offloaded to a ref, and the run summary never resolves refs, so an offloaded detail reads back as
 * no `step` and no `reason` at all — the person is told the environment could not be prepared and
 * nothing else. That was the default outcome rather than an edge case, because a failing command
 * hook's excerpt is bounded by the setup runner's 32 KiB `TailBuffer`, four times the threshold.
 *
 * 32 KiB is therefore exactly the worst case the product can produce, which is what this feeds it.
 */
test('a hook that printed 32 KiB still leaves a failure the summary can name', async () => {
  await withHarness(async (harness) => {
    publish(harness, counters());
    const outputExcerpt = Array.from(
      { length: 1024 },
      (_, line) => `${line} npm ERR! could not resolve dependency tree`,
    ).join('\n');
    assert.ok(
      Buffer.byteLength(outputExcerpt, 'utf8') >= 32 * 1024,
      'the fixture has to actually be the worst case it claims to be',
    );
    harness.owning
      .allowsWorktrees({
        setup: {
          status: 'failed',
          runId: 3,
          failedHookIndex: 2,
          failedHookType: 'command',
          message: 'pnpm install failed',
          exitCode: 1,
          outputExcerpt,
        },
      })
      .allowsSurfaces();

    const started = await harness.launch({
      workflowKey: 'placeable',
      request: createBoth('feature/chatty', 'Chatty'),
    });

    const failed = await harness.runOf(started.id);
    const attempt = (await run(harness.fixture.runs.findAttempt(failed.failureAttemptId!)))!;
    assert.equal(
      attempt.failureDetail?.ref,
      null,
      'the detail stayed inline, which is what makes it readable from the summary at all',
    );

    const detail = await failureDetailOf(harness, started.id);
    assert.equal(detail.step, 'setup');
    assert.equal(detail.reason, 'setup_failed');
    // The tail is what is kept — a hook's actual error is at the end of its output — and the
    // truncation is marked so a clipped excerpt cannot be read as the whole of it.
    const diagnostic = detail.diagnostic as string;
    assert.match(diagnostic, /^\[earlier output truncated\]\n/);
    assert.ok(diagnostic.endsWith('1023 npm ERR! could not resolve dependency tree'));
    assert.ok(
      Buffer.byteLength(diagnostic, 'utf8') <= 4096 + '[earlier output truncated]\n'.length,
      'and it is bounded, with room left for the rest of the struct',
    );

    // Nothing was lost that is held only here: the setup receipt is plain JSON in the preparation
    // row rather than a payload, so the fuller excerpt is still on the record beside this.
    const prep = (await harness.preparationOf(started.id))!;
    assert.equal(prep.setup?.failure?.outputExcerpt, outputExcerpt);
  });
});

/**
 * The other shape a chatty failure takes: one very long line, which Git and JSON both produce.
 *
 * The bound cuts at a byte offset, so with no newline in the window to resynchronize on, the cut
 * can land in the middle of a multi-byte character and leave the excerpt starting on a replacement
 * glyph. A `→` is three bytes and the window is not a multiple of three, so this lands mid-character
 * by construction rather than by luck.
 */
test('a single-line diagnostic is clipped at a character, not in the middle of one', async () => {
  await withHarness(async (harness) => {
    publish(harness, counters());
    const outputExcerpt = '→'.repeat(11000);
    assert.ok(Buffer.byteLength(outputExcerpt, 'utf8') >= 32 * 1024);
    assert.equal(outputExcerpt.includes('\n'), false, 'the point of this case is that it has none');
    harness.owning
      .allowsWorktrees({
        setup: {
          status: 'failed',
          runId: 4,
          failedHookIndex: 1,
          failedHookType: 'command',
          message: 'the formatter failed',
          exitCode: 1,
          outputExcerpt,
        },
      })
      .allowsSurfaces();

    const started = await harness.launch({
      workflowKey: 'placeable',
      request: createBoth('feature/oneline', 'One line'),
    });

    const diagnostic = (await failureDetailOf(harness, started.id)).diagnostic as string;
    assert.match(diagnostic, /^\[earlier output truncated\]\n/);
    assert.equal(
      diagnostic.includes('\ufffd'),
      false,
      'a byte-offset cut must not leave a replacement character at the front of the excerpt',
    );
    assert.ok(diagnostic.endsWith('→'));
  });
});

test('a crash between the worktree receipt and the setup receipt leaves setup unknown, and Retry re-runs it', async () => {
  await withHarness(async (harness) => {
    publish(harness, counters());
    harness.owning.allowsWorktrees().allowsSurfaces();
    // Let the worktree receipt through, then crash: the durable state a killed process leaves
    // between two transactions that share one name.
    harness.crashNext('recordEnvironmentReceipt', 1);

    const exit = await harness.launchExit({
      workflowKey: 'placeable',
      request: createBoth('feature/crash', 'Crash'),
    });
    assert.equal(exit._tag, 'Failure', 'a database fault propagates rather than being recorded');

    const interrupted = (await harness.preparationOf(1))!;
    assert.equal(interrupted.worktree?.acquisition, 'created');
    assert.equal(interrupted.setup, null);
    assert.equal(
      firstIncompleteStep(interrupted),
      'setup',
      'a null setup receipt is outstanding, never done',
    );

    // Startup recovery fails a preparing run rather than parking it: Retry is its one re-entry path.
    await harness.restart();
    const failed = await harness.runOf(1);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.position.kind, 'environment_preparation');

    harness.owning.calls.length = 0;
    harness.owning.allowsSetup({ status: 'succeeded', runId: 3 });
    const retried = await harness.retry(1);

    assert.deepEqual([retried.accepted, retried.status], [true, 'ready']);
    assert.deepEqual(harness.owning.calls, ['runWorktreeSetup', 'createSinglePaneSurface']);
    assert.equal(worktreeRows(harness).length, 2, 'the interrupted creation was reused');
    const prep = (await harness.preparationOf(1))!;
    assert.equal(prep.setup?.status, 'succeeded');
  });
});

test('a branch that is already checked out is a collision on a first attempt, never an adoption', async () => {
  await withHarness(async (harness) => {
    publish(harness, counters());
    harness.owning.allowsWorktrees().allowsSurfaces();
    // Somebody else's worktree, at Isagi's own derived path, created before this run existed. Every
    // part of the adoption predicate except the attempt kind matches — which is the point.
    const foreign = seedWorktreeRow(harness.fixture, {
      projectId: 1,
      branch: 'feature/taken',
      path: derivedCheckoutPath(1, 'feature/taken'),
    });

    const started = await harness.launch({
      workflowKey: 'placeable',
      request: createBoth('feature/taken', 'Taken'),
    });

    const detail = await failureDetailOf(harness, started.id);
    assert.deepEqual(detail, {
      step: 'worktree',
      reason: 'worktree_exists',
      branch: 'feature/taken',
      worktreeId: foreign,
    });
    const prep = (await harness.preparationOf(started.id))!;
    assert.deepEqual(
      [prep.worktree, prep.setup, prep.surface],
      [null, null, null],
      'a collision allocates nothing, so it records nothing',
    );
    assert.deepEqual(harness.owning.deletions, []);
    assert.equal(worktreeRows(harness).length, 2, "and it leaves the other run's worktree alone");
  });
});

test('Retry refuses to adopt a worktree whose path or age does not match the interruption', async () => {
  for (const mismatch of ['path', 'age'] as const) {
    await withHarness(async (harness) => {
      publish(harness, counters());
      harness.owning.allowsSurfaces();
      /**
       * A first attempt that allocated nothing, so the only worktree on the branch afterwards is
       * the one this test plants. Anything the run itself created would match the predicate — which
       * is the point of the predicate, and would make the mismatch impossible to stage.
       */
      harness.owning.setOpenWorktree(() =>
        Effect.fail(
          new GitCommandError({
            args: ['worktree', 'add'],
            cause: new Error('disk full'),
            cwd: '/repo/fixture',
            failure: { kind: 'exited', exitCode: 128 },
            stderr: 'fatal: could not create work tree dir',
          }),
        ),
      );
      const started = await harness.launch({
        workflowKey: 'placeable',
        request: createBoth('feature/mismatch', 'Mismatch'),
      });
      assert.equal((await failureDetailOf(harness, started.id)).reason, 'git_failed');
      harness.owning.allowsWorktrees();

      /**
       * A worktree on the right branch that this run did not create.
       *
       * Both mismatches are real states. A different path means somebody checked the branch out
       * somewhere Isagi would not have; an older `first_seen_at` means the row predates this
       * preparation, so the interruption cannot have produced it.
       */
      const prep = (await harness.preparationOf(started.id))!;
      seedWorktreeRow(harness.fixture, {
        projectId: 1,
        branch: 'feature/mismatch',
        path: mismatch === 'path' ? '/somewhere/else' : prep.checkoutPath!,
        ...(mismatch === 'age' ? { firstSeenAt: '2020-01-01T00:00:00.000Z' } : {}),
      });

      const retried = await harness.retry(started.id);

      assert.deepEqual(
        [retried.accepted, retried.status],
        [true, 'failed'],
        'the control accepted and ran; the preparation is what failed',
      );
      const detail = await failureDetailOf(harness, started.id);
      assert.equal(detail.reason, 'worktree_exists');
      assert.equal(detail.step, 'worktree');
      assert.equal(
        (await harness.preparationOf(started.id))!.worktree,
        null,
        'nothing was adopted',
      );
      assert.deepEqual(harness.owning.deletions, []);
    });
  }
});

test('Retry adopts the checkout its own interrupted attempt left, and re-runs setup for it', async () => {
  await withHarness(async (harness) => {
    publish(harness, counters());
    harness.owning.allowsWorktrees().allowsSurfaces();
    // Crash before the worktree receipt: the checkout exists, and nothing records that it does.
    harness.crashNext('recordEnvironmentReceipt');

    await harness.launchExit({
      workflowKey: 'placeable',
      request: createBoth('feature/adopt', 'Adopt'),
    });
    await harness.restart();
    const before = worktreeRows(harness);
    assert.equal(before.length, 2, 'the interrupted attempt really did create a checkout');

    harness.owning.calls.length = 0;
    harness.owning.allowsSetup({ status: 'succeeded', runId: 11 });
    const retried = await harness.retry(1);

    assert.deepEqual([retried.accepted, retried.status], [true, 'ready']);
    const prep = (await harness.preparationOf(1))!;
    assert.equal(prep.worktree?.acquisition, 'adopted_after_interruption');
    assert.equal(prep.worktree?.worktreePath, prep.checkoutPath);
    // Setup ran because the adoption receipt said nobody had observed whether it had, which is the
    // only honest thing to say about a checkout an interrupted attempt left behind.
    assert.deepEqual(harness.owning.calls, [
      'openWorktree',
      'runWorktreeSetup',
      'createSinglePaneSurface',
    ]);
    assert.equal(prep.setup?.status, 'succeeded');
    assert.deepEqual(
      worktreeRows(harness),
      before,
      'adoption reuses the checkout rather than creating a second one',
    );
  });
});

test('a surface created but not yet recorded is resolved again by its creation key, never duplicated', async () => {
  await withHarness(async (harness) => {
    publish(harness, counters());
    harness.owning.allowsSurfaces();
    // A reuse worktree with a created surface: the surface receipt is then the only receipt this
    // preparation writes, so crashing the next one lands exactly between creation and its record.
    harness.crashNext('recordEnvironmentReceipt');

    await harness.launchExit({
      workflowKey: 'placeable',
      request: {
        worktree: { kind: 'current' },
        surface: { kind: 'create', title: 'Keyed' },
      },
    });

    const orphan = surfaceRows(harness).find((row) => row.title === 'Keyed');
    assert.ok(orphan, 'the surface was created before the crash');
    assert.equal((await harness.preparationOf(1))!.surface, null, 'and nothing recorded it');

    await harness.restart();
    harness.owning.calls.length = 0;
    const retried = await harness.retry(1);

    assert.deepEqual([retried.accepted, retried.status], [true, 'ready']);
    assert.deepEqual(harness.owning.calls, ['createSinglePaneSurface']);
    const prep = (await harness.preparationOf(1))!;
    assert.equal(prep.surface?.surfaceId, orphan.id, 'the key resolved the same surface');
    assert.equal(
      surfaceRows(harness).filter((row) => row.title.startsWith('Keyed')).length,
      1,
      'and no second surface was made',
    );
    assert.deepEqual(
      harness.fixture.client
        .prepare('SELECT creation_key AS key FROM worktree_surfaces WHERE id = ?')
        .get(orphan.id),
      { key: surfaceCreationKey(1) },
      'and the key on the row is the one the run derives from its own id',
    );
  });
});

test('a surface taken between the pre-check and the commit fails the run, and Retry succeeds once it is free', async () => {
  await withHarness(async (harness) => {
    publish(harness, counters());
    const first = await harness.launch({ workflowKey: 'placeable' });
    await harness.drain();

    // The pre-check reads runs by destination surface and the commit reads the attachment table;
    // clearing the first run's destination while leaving its attachment reproduces the race
    // deterministically rather than by timing.
    harness.fixture.client
      .prepare('UPDATE workflow_runs SET destination_surface_id = NULL WHERE id = ?')
      .run(first.id);

    const second = await harness.launch({ workflowKey: 'placeable' });
    const detail = await failureDetailOf(harness, second.id);
    assert.deepEqual(detail, {
      step: 'commit',
      reason: 'surface_busy',
      surfaceId: harness.placement.surfaceId,
      occupyingRunId: first.id,
    });
    assert.equal(await run(harness.fixture.runs.findAttachment(second.id)), null);

    // Restore the occupant's destination so Dismiss can release it, then retry: nothing to
    // re-allocate, because a reuse placement never allocated anything in the first place.
    harness.fixture.client
      .prepare('UPDATE workflow_runs SET destination_surface_id = ? WHERE id = ?')
      .run(harness.placement.surfaceId, first.id);
    assert.equal((await run(harness.controls.dismiss(first.id))).accepted, true);

    harness.owning.calls.length = 0;
    const retried = await harness.retry(second.id);
    assert.deepEqual([retried.accepted, retried.status], [true, 'ready']);
    assert.deepEqual(harness.owning.calls, []);
    const prep = (await harness.preparationOf(second.id))!;
    assert.deepEqual([prep.worktree, prep.setup, prep.surface], [null, null, null]);
    assert.ok(await run(harness.fixture.runs.findAttachment(second.id)));
  });
});

test('a Cancel that lands mid-allocation still records the receipt, and advances nothing', async () => {
  await withHarness(async (harness) => {
    publish(harness, counters());
    harness.owning.allowsWorktrees().allowsSurfaces();

    // Cancel arrives while the worktree is being created — after the allocation happened, before
    // anything could record it. Receipts are evidence, not decisions, so the record survives.
    harness.owning.wrapOpenWorktree(
      (inner) => (input) =>
        inner(input).pipe(
          Effect.tap(() =>
            Effect.promise(async () => void (await run(harness.controls.cancel(1)))),
          ),
        ),
    );

    const started = await harness.launch({
      workflowKey: 'placeable',
      request: createBoth('feature/cancel', 'Cancel'),
    });

    const cancelled = await harness.runOf(started.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.position.kind, 'environment_preparation');
    assert.deepEqual(cancelled.destination, {
      worktreeId: null,
      worktreePath: null,
      surfaceId: null,
    });
    assert.equal(await run(harness.fixture.runs.findAttachment(started.id)), null);

    const prep = (await harness.preparationOf(started.id))!;
    assert.equal(
      prep.worktree?.acquisition,
      'created',
      'a cancelled preparation still says what it brought into existence',
    );
    assert.ok(
      transitionKinds(harness, started.id).includes('environment_step_recorded'),
      'and the record is visible in the run history',
    );
    assert.equal(prep.setup, null, 'nothing after the cancelled write ran');
    assert.deepEqual(
      harness.fixture.client
        .prepare(
          'SELECT status FROM workflow_segment_attempts WHERE run_id = ? ORDER BY attempt_index',
        )
        .all(started.id),
      [{ status: 'cancelled' }],
      'the attempt is closed as cancelled, never left running on a cancelled run',
    );
    assert.equal(worktreeRows(harness).length, 2, 'and the worktree it made is left alone');
    assert.deepEqual(harness.owning.deletions, []);
    assert.equal(await harness.drain(), 0, 'a cancelled preparation is not dispatchable');
  });
});

test('the dispatcher never claims a preparation, even one left ready by an adopted pin', async () => {
  await withHarness(async (harness) => {
    publish(harness, counters());
    harness.owning.allowsWorktrees().allowsSurfaces();
    harness.owning.setOpenWorktree(() =>
      Effect.fail(
        new GitCommandError({
          args: ['worktree', 'add'],
          cause: new Error('disk full'),
          cwd: '/repo/fixture',
          failure: { kind: 'exited', exitCode: 128 },
          stderr: 'fatal: could not create work tree dir',
        }),
      ),
    );
    const started = await harness.launch({
      workflowKey: 'placeable',
      request: createBoth('feature/stranded', 'Stranded'),
    });
    assert.equal((await harness.runOf(started.id)).status, 'failed');

    /**
     * A Retry that adopted its pin and then crashed before claiming.
     *
     * `adoptRetryPin` deliberately allocates no attempt, so this leaves an ordinary **ready** run
     * sitting at `environment_preparation` — the one state in which the dispatcher could plausibly
     * pick this segment up. It must not: a claim here would allocate an attempt for a segment the
     * worker then refuses to run, stranding it on the one segment no other party ever collects, and
     * a real preparation can hold the single worker fiber for minutes of Git and hooks.
     *
     * What this asserts is the *guarantee*, not one line of code. Two independent things enforce it
     * today — `advance`'s position check and `prepareClaim` having no arm for this position — and
     * removing either alone leaves the test green. That is worth knowing before anyone deletes one
     * as redundant: the position check is what states the intent, and the missing claim arm is what
     * would otherwise fail obscurely.
     */
    const failed = await harness.runOf(started.id);
    const pinned = await run(
      harness.fixture.runs.adoptRetryPin({
        runId: started.id,
        controlRevision: failed.controlRevision,
        artifactHash: failed.artifactHash,
        expectedPosition: failed.position,
        expectedOwner: null,
      }),
    );
    assert.equal(pinned.ok, true);
    const ready = await harness.runOf(started.id);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.position.kind, 'environment_preparation');

    // The run really is one the worker would otherwise pick up: `listDispatchable` returns it, so
    // the only thing keeping the dispatcher off this segment is the position check itself.
    assert.deepEqual(
      (await run(harness.fixture.runs.listDispatchable())).map((candidate) => candidate.id),
      [started.id],
    );

    const attemptsBefore = harness.fixture.client
      .prepare('SELECT count(*) AS count FROM workflow_segment_attempts WHERE run_id = ?')
      .get(started.id);

    assert.equal(await harness.drain(), 0, 'the dispatcher advances nothing');
    assert.deepEqual(
      harness.fixture.client
        .prepare('SELECT count(*) AS count FROM workflow_segment_attempts WHERE run_id = ?')
        .get(started.id),
      attemptsBefore,
      'and it claims no attempt on a segment it will not run',
    );
    const after = await harness.runOf(started.id);
    assert.equal(after.position.kind, 'environment_preparation');
    assert.equal(
      after.owner,
      null,
      'the run is left exactly as Retry left it, for Retry to pick up',
    );
  });
});

test('an untrusted hook configuration is an honest preparation failure that keeps the checkout', async () => {
  await withHarness(async (harness) => {
    publish(harness, counters());
    harness.owning.allowsWorktrees().allowsSurfaces();
    // Crash before the worktree receipt, so the retry adopts the checkout and must then ask the
    // setup runner about it — the only route that reaches `runWorktreeSetup` with a real refusal.
    harness.crashNext('recordEnvironmentReceipt');
    await harness.launchExit({
      workflowKey: 'placeable',
      request: createBoth('feature/trust', 'Trust'),
    });
    await harness.restart();

    /**
     * A workflow launch cannot answer an interactive trust prompt.
     *
     * Reporting it as a preparation failure is the honest option: the person trusts the hooks
     * through the workspace UI and retries. Skipping them silently would hand the run a checkout
     * that looks prepared and is not.
     */
    harness.owning.setRunWorktreeSetup(() =>
      Effect.fail(
        new WorktreeSetupError({
          code: 'setup_trust_required',
          message: 'these hooks have not been trusted yet',
        }),
      ),
    );
    const retried = await harness.retry(1);

    assert.deepEqual([retried.accepted, retried.status], [true, 'failed']);
    const detail = await failureDetailOf(harness, 1);
    assert.equal(detail.step, 'setup');
    assert.equal(detail.reason, 'setup_trust_required');

    const prep = (await harness.preparationOf(1))!;
    assert.equal(prep.worktree?.acquisition, 'adopted_after_interruption');
    assert.equal(
      prep.setup?.status,
      'unknown',
      'the unresolved setup stands, so a retry asks again',
    );
    assert.equal(worktreeRows(harness).length, 2, 'the checkout is left exactly where it is');
    assert.deepEqual(harness.owning.deletions, []);
    assert.equal(await run(harness.fixture.runs.findAttachment(1)), null);
    assert.equal(await harness.drain(), 0, 'a failed preparation is not dispatchable');
  });
});
