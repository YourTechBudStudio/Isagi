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
import { Cause, Exit, Option } from 'effect';

import { run } from '../persistence/test-support.js';
import type { AnyWorkflowDefinition } from '../structure/loader.js';
import { WorkflowEngineError } from '../types.js';
import { makeEngineHarness, type EngineHarness } from './test-support.js';

/**
 * Launch, and the promise that a rejected launch leaves nothing behind.
 *
 * The order is load → origin → project → `command` → `validate` → select → resolve → create, and
 * every step before the last is a *launch* failure rather than a run that immediately fails. `init`
 * is deliberately not in that list: it runs as the first segment, which is what makes a failed
 * initialization inspectable and retryable instead of a launch that vanished.
 *
 * Each case below asserts the distinct reason *and* that no run, frame, attachment, version
 * adoption or transition exists afterwards. A launch that half-happened would be far worse than one
 * that was refused.
 *
 * Placement selection and the rejection table have their own file,
 * [`environment/placement.test.ts`](./environment/placement.test.ts). What stays here is the launch
 * *order* and what survives a refusal.
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
}

function launchableWorkflow(
  counters: Counters,
  options: { readonly commandThrows?: boolean; readonly validateThrows?: boolean } = {},
): AnyWorkflowDefinition {
  const graph = createGraph<{ readonly rounds: number }, {}, Record<string, unknown>>({
    key: 'launchable',
    title: 'Launchable',
    init: () => {
      counters.init += 1;
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
      counters.command += 1;
      if (options.commandThrows) throw new Error('this workflow cannot build a command manifest');
      return { title: 'Launchable' };
    },
    validate: (_origin, inputs) => {
      counters.validate += 1;
      if (options.validateThrows || typeof inputs.topic !== 'string') {
        throw new Error('a topic is required');
      }
    },
    graph,
  }) as AnyWorkflowDefinition;
}

function rejectionOf(exit: Exit.Exit<unknown, unknown>): WorkflowEngineError {
  assert.equal(exit._tag, 'Failure', 'expected the launch to be refused');
  if (exit._tag !== 'Failure') throw new Error('unreachable');
  const failure = Option.getOrNull(Cause.failureOption(exit.cause));
  assert.ok(
    failure instanceof WorkflowEngineError,
    `expected a WorkflowEngineError, got ${String(failure)}`,
  );
  return failure;
}

/** Nothing a launch touches survives a rejection — checked against the tables, not the return. */
async function assertNothingWasCreated(harness: EngineHarness) {
  const counts = harness.fixture.client
    .prepare(
      `SELECT
         (SELECT count(*) FROM workflow_runs) AS runs,
         (SELECT count(*) FROM workflow_graph_frames) AS frames,
         (SELECT count(*) FROM workflow_run_attachments) AS attachments,
         (SELECT count(*) FROM workflow_version_adoptions) AS adoptions,
         (SELECT count(*) FROM workflow_transitions) AS transitions,
         (SELECT count(*) FROM workflow_segment_attempts) AS attempts,
         (SELECT count(*) FROM workflow_run_preparations) AS preparations`,
    )
    .get() as Record<string, number>;
  assert.deepEqual(counts, {
    runs: 0,
    frames: 0,
    attachments: 0,
    adoptions: 0,
    transitions: 0,
    attempts: 0,
    preparations: 0,
  });
}

test('an unknown workflow key is refused, and names what is available', async () => {
  await withHarness(async (harness) => {
    const counters: Counters = { command: 0, validate: 0, init: 0 };
    harness.publish({
      workflowKey: 'launchable',
      version: '1',
      definition: launchableWorkflow(counters),
    });

    const failure = rejectionOf(await harness.launchExit({ workflowKey: 'nope' }));
    assert.equal(failure.code, 'unknown_workflow_key');
    assert.deepEqual(failure.knownWorkflowKeys, ['launchable']);
    assert.deepEqual([counters.command, counters.validate, counters.init], [0, 0, 0]);
    await assertNothingWasCreated(harness);
  });
});

test('a workflow that cannot be loaded is refused with its load reason', async () => {
  await withHarness(async (harness) => {
    const counters: Counters = { command: 0, validate: 0, init: 0 };
    harness.publish({
      workflowKey: 'launchable',
      version: '1',
      definition: launchableWorkflow(counters),
    });
    // Discoverable, but its build no longer matches its source — which is one of the reasons the
    // loader refuses to import a package at all.
    harness.breakNextLoad('stale_source');

    const failure = rejectionOf(await harness.launchExit({ workflowKey: 'launchable' }));
    assert.equal(failure.code, 'workflow_load_failed');
    assert.equal(failure.workflowLoadFailureReason, 'stale_source');
    assert.deepEqual(
      [counters.command, counters.validate, counters.init],
      [0, 0, 0],
      'no author code runs for a package that cannot be imported',
    );
    await assertNothingWasCreated(harness);

    // The next launch loads normally, so the failure was the build and not the workflow.
    const launched = await harness.launch({
      workflowKey: 'launchable',
      inputs: { topic: 'recovered' },
    });
    assert.ok(launched.id > 0);
  });
});

test('a destination that is not there is refused before any author code runs', async () => {
  await withHarness(async (harness) => {
    const counters: Counters = { command: 0, validate: 0, init: 0 };
    harness.publish({
      workflowKey: 'launchable',
      version: '1',
      definition: launchableWorkflow(counters),
    });

    const missingWorktree = rejectionOf(
      await harness.launchExit({
        workflowKey: 'launchable',
        origin: { worktreeId: 9999, surfaceId: harness.placement.surfaceId },
      }),
    );
    assert.equal(missingWorktree.code, 'worktree_not_found');

    const missingSurface = rejectionOf(
      await harness.launchExit({
        workflowKey: 'launchable',
        origin: { worktreeId: harness.placement.worktreeId, surfaceId: 9999 },
      }),
    );
    assert.equal(missingSurface.code, 'surface_not_found');

    // A surface that exists but belongs to somewhere else. Placement is descriptive, but recording
    // a surface that was never on this worktree would make the provenance misleading.
    const elsewhere = harness.seedPlacement();
    const mismatched = rejectionOf(
      await harness.launchExit({
        workflowKey: 'launchable',
        origin: { worktreeId: harness.placement.worktreeId, surfaceId: elsewhere.surfaceId },
      }),
    );
    assert.equal(mismatched.code, 'surface_worktree_mismatch');

    assert.deepEqual(
      [counters.command, counters.validate, counters.init],
      [0, 0, 0],
      'placement is validated before a command manifest is ever built',
    );
    await assertNothingWasCreated(harness);
  });
});

test('a command manifest that throws and inputs that are refused are different failures', async () => {
  await withHarness(async (harness) => {
    const commandCounters: Counters = { command: 0, validate: 0, init: 0 };
    harness.publish({
      workflowKey: 'launchable',
      version: 'broken-command',
      definition: launchableWorkflow(commandCounters, { commandThrows: true }),
    });

    const commandFailure = rejectionOf(await harness.launchExit({ workflowKey: 'launchable' }));
    assert.equal(commandFailure.code, 'workflow_command_failed');
    assert.deepEqual(
      [commandCounters.command, commandCounters.validate],
      [1, 0],
      'validation is never reached when the manifest itself cannot be built',
    );
    await assertNothingWasCreated(harness);

    // v1 collapsed these two into one `validation_failed`; they are separate reasons now because a
    // person can act on them differently.
    const inputCounters: Counters = { command: 0, validate: 0, init: 0 };
    harness.publish({
      workflowKey: 'launchable',
      version: 'strict-inputs',
      definition: launchableWorkflow(inputCounters),
    });
    harness.setCurrent('launchable', 'strict-inputs');

    const inputFailure = rejectionOf(await harness.launchExit({ workflowKey: 'launchable' }));
    assert.equal(inputFailure.code, 'workflow_inputs_rejected');
    assert.deepEqual([inputCounters.command, inputCounters.validate], [1, 1]);
    assert.equal(inputCounters.init, 0, 'and init is not a launch hook at all');
    await assertNothingWasCreated(harness);

    // The same workflow launches once its inputs are acceptable.
    const launched = await harness.launch({
      workflowKey: 'launchable',
      inputs: { topic: 'acceptable' },
    });
    assert.ok(launched.id > 0);
  });
});

test('a surface that already holds a run refuses the next launch, terminal run included', async () => {
  // Retargeted, not deleted: the check moved from the *origin* surface to the *destination* one.
  // With the default current/current placement they are the same surface, so this is still the
  // ordinary case a person meets — the launch headed somewhere else is covered in
  // `environment/placement.test.ts`.
  await withHarness(async (harness) => {
    const counters: Counters = { command: 0, validate: 0, init: 0 };
    harness.publish({
      workflowKey: 'launchable',
      version: '1',
      definition: launchableWorkflow(counters),
    });
    const first = await harness.launch({
      workflowKey: 'launchable',
      inputs: { topic: 'first' },
    });
    await harness.drain();
    assert.equal((await harness.runOf(first.id)).status, 'done');

    // A finished run keeps its placement until it is dismissed, so the surface is still occupied.
    const before = harness.fixture.client
      .prepare('SELECT count(*) AS count FROM workflow_runs')
      .get() as { count: number };
    const busy = rejectionOf(
      await harness.launchExit({ workflowKey: 'launchable', inputs: { topic: 'second' } }),
    );
    assert.equal(busy.code, 'workflow_surface_attached');
    assert.equal(busy.activeWorkflowRunId, first.id);
    assert.deepEqual(
      harness.fixture.client.prepare('SELECT count(*) AS count FROM workflow_runs').get(),
      before,
      'the refused launch created no second run',
    );

    // Dismiss releases the placement, and then the next launch is accepted.
    assert.equal((await run(harness.controls.dismiss(first.id))).accepted, true);
    const second = await harness.launch({
      workflowKey: 'launchable',
      inputs: { topic: 'second' },
    });
    assert.notEqual(second.id, first.id);
    assert.ok(await run(harness.fixture.runs.findAttachment(second.id)));
    assert.equal(
      await run(harness.fixture.runs.findAttachment(first.id)),
      null,
      'and the dismissed run keeps its history without its placement',
    );
  });
});

test('an occupant that appears after the pre-check leaves a failed run, never a stranded one', async () => {
  await withHarness(async (harness) => {
    const counters: Counters = { command: 0, validate: 0, init: 0 };
    harness.publish({
      workflowKey: 'launchable',
      version: '1',
      definition: launchableWorkflow(counters),
    });
    const first = await harness.launch({ workflowKey: 'launchable', inputs: { topic: 'first' } });

    // The race the commit's occupancy check exists for, made deterministic: the pre-check reads
    // runs *by destination surface*, the commit reads the *attachment* table, and between the two
    // a concurrent launch can occupy the surface. Detaching the first run's destination while
    // leaving its attachment reproduces exactly that divergence — the pre-check sees a free
    // surface, the commit sees the occupant.
    harness.fixture.client
      .prepare('UPDATE workflow_runs SET destination_surface_id = NULL WHERE id = ?')
      .run(first.id);

    const refused = rejectionOf(
      await harness.launchExit({ workflowKey: 'launchable', inputs: { topic: 'second' } }),
    );
    assert.equal(refused.code, 'workflow_surface_attached');
    assert.equal(refused.activeWorkflowRunId, first.id, 'and it names the run holding the surface');

    // The refused launch did create a run, because it had already claimed one — and that run is
    // *failed*, not left owned and running at a segment the dispatcher never claims.
    const strandedId = refused.workflowRunId!;
    assert.notEqual(strandedId, first.id);
    const stranded = await harness.runOf(strandedId);
    assert.equal(stranded.status, 'failed');
    assert.equal(stranded.failureCode, 'environment_preparation_failed');
    assert.equal(stranded.owner, null, 'ownership was released');
    assert.equal(stranded.activeAttemptId, null);
    assert.ok(stranded.endedAt);
    assert.deepEqual(stranded.destination, {
      worktreeId: null,
      worktreePath: null,
      surfaceId: null,
    });
    assert.equal(
      await run(harness.fixture.runs.findAttachment(strandedId)),
      null,
      'and it occupies nothing',
    );

    const attempt = (await run(harness.fixture.runs.findAttempt(stranded.failureAttemptId!)))!;
    assert.equal(attempt.segmentKind, 'environment_preparation');
    assert.equal(attempt.status, 'failed');
    assert.deepEqual(await run(harness.fixture.payloads.resolve(attempt.failureDetail!)), {
      step: 'commit',
      reason: 'surface_busy',
      surfaceId: harness.placement.surfaceId,
      occupyingRunId: first.id,
    });

    // Nothing is waiting for it: the dispatcher has no claimable run left.
    assert.equal(await harness.drain(), 0);
  });
});
