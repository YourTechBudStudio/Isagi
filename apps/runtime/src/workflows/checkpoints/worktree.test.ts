import assert from 'node:assert/strict';
import test from 'node:test';

import { drizzle } from 'drizzle-orm/better-sqlite3';
import { Effect, Either } from 'effect';
import Fastify from 'fastify';

import { workflowRuns } from '../../persistence/schema.js';
import { DetachedWorktreeError, WorkspaceService } from '../../workspace/index.js';
import type { WorkspaceServiceShape } from '../../workspace/index.js';
import { registerWorkflowApi } from '../api.js';
import { WorkflowEngine } from '../engine/interpreter.service.js';
import type { WorkflowCheckpointRecord } from '../persistence/records.js';
import {
  makeWorkflowRunProjection,
  WorkflowRunProjection,
  type WorkflowRunProjectionService,
} from '../read/projection.service.js';
import { WorkflowEngineError } from '../types.js';
import { makeCaptureHarness, type CaptureHarness } from './capture.test-support.js';
import { prepareCheckpointWorktree, toCheckpointWorktreeRejection } from './worktree.js';

/**
 * The composer over real captured checkpoints and the real projection, with the workspace faked:
 * detached creation itself is proven against real Git in `service.worktree-detached.test.ts`. What
 * is proven here is that the checkpoint, not the caller, picks the repository and commit, and that
 * every workspace failure reaches the client as the right workflow reason and status.
 */

type DetachedInput = Parameters<WorkspaceServiceShape['createDetachedWorktree']>[0];
type DetachedOutcome = ReturnType<WorkspaceServiceShape['createDetachedWorktree']>;

interface Setup {
  readonly harness: CaptureHarness;
  readonly projection: WorkflowRunProjectionService;
  readonly runId: number;
  readonly checkpoint: WorkflowCheckpointRecord;
}

async function withCheckpoint(
  kind: 'git' | 'folder',
  body: (setup: Setup) => Promise<void>,
): Promise<void> {
  const harness = makeCaptureHarness({ kind, label: 'checkpoint-worktree' });
  try {
    harness.write('docs/a.md', 'alpha');
    if (kind === 'git') harness.commitAll('base');
    harness.write('docs/a.md', 'alpha changed');
    const checkpoint = await harness.captureOk([{ scope: 'docs', directory: 'docs' }]);
    const runId = drizzle(harness.fixture.client).select().from(workflowRuns).get()!.id;
    const projection = makeWorkflowRunProjection(
      harness.fixture.database,
      harness.fixture.payloads,
      harness.fixture.content,
    );
    await body({ harness, projection, runId, checkpoint });
  } finally {
    harness.close();
  }
}

function fakeWorkspace(create: (input: DetachedInput) => DetachedOutcome) {
  const calls: DetachedInput[] = [];
  const service = {
    createDetachedWorktree: (input: DetachedInput) => {
      calls.push(input);
      return create(input);
    },
  } as unknown as WorkspaceServiceShape;
  return { service, calls };
}

function prepare(
  setup: Setup,
  workspace: WorkspaceServiceShape,
  input: {
    readonly runId?: number;
    readonly checkpointId?: string;
    readonly destinationPath: string;
  },
) {
  return Effect.runPromise(
    prepareCheckpointWorktree({
      runId: input.runId ?? setup.runId,
      checkpointId: input.checkpointId ?? setup.checkpoint.checkpointKey,
      destinationPath: input.destinationPath,
    }).pipe(
      Effect.provideService(WorkflowRunProjection, setup.projection),
      Effect.provideService(WorkspaceService, workspace),
      Effect.either,
    ),
  );
}

function rejectionOf(result: Either.Either<unknown, unknown>): WorkflowEngineError {
  assert.ok(Either.isLeft(result), 'expected a rejection');
  assert.ok(result.left instanceof WorkflowEngineError, String(result.left));
  return result.left;
}

function detachedError(
  reason: DetachedWorktreeError['reason'],
  extra: Partial<DetachedWorktreeError> = {},
) {
  return new DetachedWorktreeError({
    reason,
    message: `injected ${reason}`,
    projectId: 7,
    path: '/canonical/destination',
    ...extra,
  });
}

/**
 * Keyed by every workspace reason, so adding a reason without deciding its workflow reason fails to
 * compile here as well as in the composer's `switch`.
 */
const mapping: Record<
  DetachedWorktreeError['reason'],
  {
    readonly error: DetachedWorktreeError;
    readonly code: WorkflowEngineError['code'];
    readonly status: number;
    readonly data: Record<string, unknown>;
  }
> = {
  project_unavailable: {
    error: detachedError('project_unavailable'),
    code: 'workflow_checkpoint_repository_unavailable',
    status: 409,
    data: { projectId: 7 },
  },
  destination_rejected: {
    error: detachedError('destination_rejected', {
      destinationIssue: 'inside_checkout',
      containingWorktreeId: 3,
    }),
    code: 'workflow_checkpoint_destination_rejected',
    status: 409,
    data: {
      destinationPath: '/canonical/destination',
      destinationIssue: 'inside_checkout',
      worktreeId: 3,
    },
  },
  commit_not_found: {
    error: detachedError('commit_not_found'),
    code: 'workflow_checkpoint_commit_unavailable',
    status: 409,
    data: { projectId: 7 },
  },
  git_add_failed: {
    error: detachedError('git_add_failed', { created: false }),
    code: 'workflow_checkpoint_worktree_failed',
    status: 500,
    data: { destinationPath: '/canonical/destination', stage: 'git_add', created: false },
  },
  registration_failed: {
    error: detachedError('registration_failed', { created: true }),
    code: 'workflow_checkpoint_worktree_failed',
    status: 500,
    data: { destinationPath: '/canonical/destination', stage: 'register', created: true },
  },
};

test('every detached-worktree reason maps to its workflow reason', () => {
  const context = { runId: 1, checkpointId: 'wcp_1', commitSha: 'a'.repeat(40) };
  for (const [reason, expected] of Object.entries(mapping)) {
    const mapped = toCheckpointWorktreeRejection(expected.error, context);
    assert.equal(mapped.code, expected.code, reason);
    assert.equal(mapped.checkpointId, 'wcp_1', reason);
    assert.equal(mapped.workflowRunId, 1, reason);
  }
  const commit = toCheckpointWorktreeRejection(mapping.commit_not_found.error, context);
  assert.equal(commit.commitSha, context.commitSha);
  assert.equal(commit.projectId, 7);
});

test('the checkpoint, not the caller, names the repository and commit', async () => {
  await withCheckpoint('git', async (setup) => {
    assert.equal(setup.checkpoint.base.kind, 'git');
    const base = setup.checkpoint.base as { repositoryId: number; commitSha: string };
    const { service, calls } = fakeWorkspace((input) =>
      Effect.succeed({
        projectId: input.projectId,
        worktreeId: 42,
        path: '/canonical/x',
        head: null,
      }),
    );
    const result = await prepare(setup, service, { destinationPath: '/typed/x' });

    assert.deepEqual(calls, [
      { projectId: base.repositoryId, commit: base.commitSha, path: '/typed/x' },
    ]);
    assert.ok(Either.isRight(result));
    // The destination reported is the one the runtime created, not the one the caller typed.
    assert.deepEqual(result.right, {
      runId: setup.runId,
      checkpointId: setup.checkpoint.checkpointKey,
      destinationPath: '/canonical/x',
      base: { kind: 'git', repositoryId: base.repositoryId, commitSha: base.commitSha },
      worktreeId: 42,
    });
  });
});

test('a checkpoint without a Git base is workflow_checkpoint_base_not_git, and creates nothing', async () => {
  await withCheckpoint('folder', async (setup) => {
    assert.equal(setup.checkpoint.base.kind, 'none');
    const { service, calls } = fakeWorkspace(() => Effect.die('must not be called'));
    const error = rejectionOf(await prepare(setup, service, { destinationPath: '/x' }));
    assert.equal(error.code, 'workflow_checkpoint_base_not_git');
    assert.equal(error.checkpointId, setup.checkpoint.checkpointKey);
    assert.deepEqual(calls, []);
  });
});

test("another run's checkpoint is workflow_checkpoint_not_found, and an unknown run is not found", async () => {
  await withCheckpoint('git', async (setup) => {
    const other = drizzle(setup.harness.fixture.client)
      .insert(workflowRuns)
      .values({
        workflowKey: 'fixture',
        projectId: setup.harness.projectId,
        title: 'Other run',
        rootGraphKey: 'root',
        artifactHash: 'a'.repeat(64),
        status: 'running',
        positionJson: JSON.stringify({ kind: 'graph_entry', frameId: 1 }),
        createdAt: '2026-09-24T00:00:00.000Z',
        updatedAt: '2026-09-24T00:00:00.000Z',
      })
      .returning()
      .get();
    const { service, calls } = fakeWorkspace(() => Effect.die('must not be called'));

    const foreign = rejectionOf(
      await prepare(setup, service, { runId: other.id, destinationPath: '/x' }),
    );
    assert.equal(foreign.code, 'workflow_checkpoint_not_found');
    const unknown = rejectionOf(
      await prepare(setup, service, { runId: 9999, destinationPath: '/x' }),
    );
    assert.equal(unknown.code, 'workflow_run_not_found');
    assert.deepEqual(calls, []);
  });
});

// ---------------------------------------------------------------------------
// HTTP: envelope, status per reason, result fields
// ---------------------------------------------------------------------------

function serve(projection: WorkflowRunProjectionService, workspace: WorkspaceServiceShape) {
  const fastify = Fastify({ logger: false });
  registerWorkflowApi(fastify, {
    runPromise: async <A>(effect: Effect.Effect<A, unknown, never>) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provideService(WorkflowEngine, {} as never),
          Effect.provideService(WorkflowRunProjection, projection),
          Effect.provideService(WorkspaceService, workspace),
        ) as Effect.Effect<A, unknown, never>,
      ),
  } as never);
  return fastify;
}

interface Envelope {
  readonly data?: Record<string, unknown>;
  readonly error?: { readonly code: string; readonly data: Record<string, unknown> };
}

test('the route answers in the standard envelopes, with a status for every reason', async () => {
  await withCheckpoint('git', async (setup) => {
    const base = setup.checkpoint.base as { repositoryId: number; commitSha: string };
    let next: () => DetachedOutcome = () =>
      Effect.succeed({
        projectId: base.repositoryId,
        worktreeId: 42,
        path: '/canonical/x',
        head: null,
      });
    const { service } = fakeWorkspace(() => next());
    const fastify = serve(setup.projection, service);
    const url = `/api/v1/workflows/runs/${setup.runId}/checkpoints/${setup.checkpoint.checkpointKey}/worktrees`;
    const post = async (body: unknown) => {
      const response = await fastify.inject({ method: 'POST', url, payload: body as object });
      return { status: response.statusCode, body: JSON.parse(response.body) as Envelope };
    };
    try {
      const created = await post({ destinationPath: '/typed/x' });
      assert.equal(created.status, 200);
      assert.deepEqual(created.body.data, {
        runId: setup.runId,
        checkpointId: setup.checkpoint.checkpointKey,
        destinationPath: '/canonical/x',
        base: { kind: 'git', repositoryId: base.repositoryId, commitSha: base.commitSha },
        worktreeId: 42,
      });

      const empty = await post({ destinationPath: '' });
      assert.equal(empty.status, 400);
      assert.equal(empty.body.error?.code, 'api_request_decoding_failed');

      for (const [reason, expected] of Object.entries(mapping)) {
        next = () => Effect.fail(expected.error);
        const refused = await post({ destinationPath: '/typed/x' });
        assert.equal(refused.status, expected.status, reason);
        assert.equal(refused.body.error?.code, 'workflow_rejected', reason);
        assert.deepEqual(
          refused.body.error?.data,
          {
            reason: expected.code,
            workflowRunId: setup.runId,
            checkpointId: setup.checkpoint.checkpointKey,
            ...expected.data,
            ...(reason === 'commit_not_found' ? { commitSha: base.commitSha } : {}),
          },
          reason,
        );
      }
    } finally {
      await fastify.close();
    }
  });
});

test('a folder checkpoint is refused over HTTP with 400', async () => {
  await withCheckpoint('folder', async (setup) => {
    const { service } = fakeWorkspace(() => Effect.die('must not be called'));
    const fastify = serve(setup.projection, service);
    try {
      const response = await fastify.inject({
        method: 'POST',
        url: `/api/v1/workflows/runs/${setup.runId}/checkpoints/${setup.checkpoint.checkpointKey}/worktrees`,
        payload: { destinationPath: '/x' },
      });
      assert.equal(response.statusCode, 400);
      assert.equal(
        (JSON.parse(response.body) as Envelope).error?.data.reason,
        'workflow_checkpoint_base_not_git',
      );
    } finally {
      await fastify.close();
    }
  });
});
