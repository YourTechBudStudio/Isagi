import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Either, Layer } from 'effect';

import { DataDirectory, RuntimeDatabase, RuntimeDatabaseLive } from '../persistence/index.js';
import { workflowRuns } from '../persistence/schema.js';
import { makeTestDataDirectory } from '../persistence/test-support.js';
import { cont, done } from './constructors.js';
import { createWorkflowRegistry, WorkflowRegistry, WorkflowRegistryLive } from './registry.js';
import { WorkflowRepository, WorkflowRepositoryLive } from './repository.js';
import { WorkflowEngineError } from './types.js';
import { WorkflowEngine, WorkflowEngineLive } from './workflow-engine.service.js';

test('drainOnce runs an agentless cont workflow to done', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-cont-'));
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* WorkflowRepository;
        const engine = yield* WorkflowEngine;
        const run = yield* repository.createRun({
          workflowKey: 'agentless-cont-done',
          state: { phase: 'a', snapshots: ['a'] },
          stateVersion: 1,
        });

        const summary = yield* engine.drainOnce;
        const completed = yield* repository.findRun(run.id);
        return { summary, completed };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(result.summary.claimed, 3);
    assert.equal(result.completed?.status, 'done');
    assert.deepEqual(JSON.parse(result.completed?.stateJson ?? '{}'), {
      phase: 'c',
      snapshots: ['a', 'b', 'c'],
    });
    assert.deepEqual(JSON.parse(result.completed?.uiFeedback ?? '{}'), {
      phase: 'almost_done',
      message: 'Agentless workflow advanced.',
    });
    assert.equal(result.completed?.owner, null);
    assert.equal(result.completed?.waitKind, null);
    assert.equal(result.completed?.waitCondition, null);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('drainOnce persists suspend as waiting without progressing it', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-suspend-'));
  try {
    const row = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* WorkflowRepository;
        const engine = yield* WorkflowEngine;
        const run = yield* repository.createRun({
          workflowKey: 'agentless-suspend',
          state: { phase: 'start' },
          stateVersion: 1,
        });

        yield* engine.drainOnce;
        return yield* repository.findRun(run.id);
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(row?.status, 'waiting');
    assert.equal(row?.waitKind, 'turn');
    assert.deepEqual(JSON.parse(row?.waitCondition ?? '{}'), {
      kind: 'turn',
      agentSessionId: 10,
      harnessSessionId: 'phase-1-fixture',
      afterT: '2026-06-18T00:00:00.000Z',
    });
    assert.deepEqual(JSON.parse(row?.stateJson ?? '{}'), { phase: 'waiting' });
    assert.equal(row?.owner, null);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('thrown workflow step marks failed and preserves pre-step state and ui feedback', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-failed-'));
  try {
    const row = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* WorkflowRegistry;
        yield* registry.addWorkflow('feedback-then-throws', {
          initialState: { phase: 'before_throw' },
          step: async (ctx) => {
            await ctx.setUiFeedback({ phase: 'throwing' });
            throw new Error('boom');
          },
        });
        const repository = yield* WorkflowRepository;
        const engine = yield* WorkflowEngine;
        const run = yield* repository.createRun({
          workflowKey: 'feedback-then-throws',
          state: { phase: 'before_throw' },
          stateVersion: 1,
        });

        yield* engine.drainOnce;
        return yield* repository.findRun(run.id);
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(row?.status, 'failed');
    assert.deepEqual(JSON.parse(row?.stateJson ?? '{}'), { phase: 'before_throw' });
    assert.deepEqual(JSON.parse(row?.uiFeedback ?? '{}'), { phase: 'throwing' });
    assert.match(JSON.parse(row?.error ?? '{}').message, /boom/);
    assert.equal(row?.owner, null);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('runtime unknown workflow key uses the failed path with a diagnostic', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-unknown-runtime-'));
  try {
    const row = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* WorkflowRepository;
        const engine = yield* WorkflowEngine;
        const run = yield* repository.createRun({
          workflowKey: 'removed-workflow',
          state: { phase: 'stale' },
          stateVersion: 1,
        });

        yield* engine.drainOnce;
        return yield* repository.findRun(run.id);
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(row?.status, 'failed');
    assert.match(JSON.parse(row?.error ?? '{}').message, /Unknown workflow_key 'removed-workflow'/);
    assert.deepEqual(JSON.parse(row?.stateJson ?? '{}'), { phase: 'stale' });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('startDevRun rejects unknown workflow keys before insert', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-unknown-start-'));
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine;
        const started = yield* engine.startDevRun({ workflowKey: 'missing' }).pipe(Effect.either);
        const rows = yield* listWorkflowRuns;
        return { started, rows };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.ok(Either.isLeft(result.started));
    assert.ok(result.started.left instanceof WorkflowEngineError);
    assert.deepEqual(result.rows, []);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('startup ready-row initialization drains rows that predate the engine fiber', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-startup-drain-'));
  try {
    const runId = await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* RuntimeDatabase;
        return yield* database.use('seed_ready_workflow_before_engine_start', (db) => {
          const now = '2026-06-18T00:00:00.000Z';
          return db
            .insert(workflowRuns)
            .values({
              workflowKey: 'startup-fixture',
              worktreeId: null,
              surfaceId: null,
              status: 'ready',
              waitKind: null,
              waitCondition: null,
              resumePayload: null,
              stateJson: JSON.stringify({ phase: 'ready_before_start' }),
              stateVersion: 1,
              owner: null,
              uiFeedback: null,
              error: null,
              createdAt: now,
              updatedAt: now,
            })
            .returning({ id: workflowRuns.id })
            .get().id;
        });
      }).pipe(Effect.provide(databaseLayer(dataRoot))),
    );

    const row = await Effect.runPromise(
      Effect.gen(function* () {
        yield* WorkflowEngine;
        const repository = yield* WorkflowRepository;
        return yield* repository.findRun(runId);
      }).pipe(
        Effect.provide(
          workflowLayer(
            dataRoot,
            Layer.succeed(
              WorkflowRegistry,
              createWorkflowRegistry({
                'startup-fixture': {
                  initialState: { phase: 'unused' },
                  step: async () => done(),
                },
              }),
            ),
          ),
        ),
      ),
    );

    assert.equal(row?.status, 'done');
    assert.equal(row?.owner, null);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('drainOnce claim leaves already-claimed ready rows to the winning worker', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-claim-'));
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* WorkflowRepository;
        const run = yield* repository.createRun({
          workflowKey: 'agentless-cont-done',
          state: { phase: 'a', snapshots: ['a'] },
          stateVersion: 1,
        });

        const firstClaim = yield* repository.claimReadyRun({ runId: run.id, owner: 'worker-a' });
        const secondClaim = yield* repository.claimReadyRun({ runId: run.id, owner: 'worker-b' });
        const row = yield* repository.findRun(run.id);
        return { firstClaim, secondClaim, row };
      }).pipe(Effect.provide(repositoryOnlyLayer(dataRoot))),
    );

    assert.equal(result.firstClaim?.status, 'running');
    assert.equal(result.firstClaim?.owner, 'worker-a');
    assert.equal(result.secondClaim, null);
    assert.equal(result.row?.status, 'running');
    assert.equal(result.row?.owner, 'worker-a');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('result writes do not clobber ui feedback from the same step', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-feedback-targeted-'));
  try {
    const row = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* WorkflowRegistry;
        yield* registry.addWorkflow('feedback-then-cont', {
          initialState: { phase: 'set_feedback' },
          step: async (ctx, state) => {
            const current = state as { readonly phase: string };
            if (current.phase === 'set_feedback') {
              await ctx.setUiFeedback({ phase: 'set' });
              return cont({ phase: 'done' });
            }
            return done();
          },
        });
        const repository = yield* WorkflowRepository;
        const engine = yield* WorkflowEngine;
        const run = yield* repository.createRun({
          workflowKey: 'feedback-then-cont',
          state: { phase: 'set_feedback' },
          stateVersion: 1,
        });

        yield* engine.drainOnce;
        return yield* repository.findRun(run.id);
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(row?.status, 'done');
    assert.deepEqual(JSON.parse(row?.uiFeedback ?? '{}'), { phase: 'set' });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

const listWorkflowRuns = Effect.gen(function* () {
  const database = yield* RuntimeDatabase;
  return yield* database.use('test_list_workflow_runs', (db) =>
    db.select().from(workflowRuns).all(),
  );
});

function testLayer(dataRoot: string) {
  return workflowLayer(dataRoot, WorkflowRegistryLive);
}

function repositoryOnlyLayer(dataRoot: string) {
  const database = databaseLayer(dataRoot);
  return WorkflowRepositoryLive.pipe(Layer.provide(database));
}

function workflowLayer(
  dataRoot: string,
  registry: Layer.Layer<import('./registry.js').WorkflowRegistryService>,
) {
  const database = databaseLayer(dataRoot);
  const repository = WorkflowRepositoryLive.pipe(Layer.provide(database));
  const engine = WorkflowEngineLive.pipe(Layer.provide(repository), Layer.provide(registry));
  return Layer.mergeAll(engine, repository, registry, database);
}

function databaseLayer(dataRoot: string) {
  return RuntimeDatabaseLive.pipe(
    Layer.provide(Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot))),
  );
}
