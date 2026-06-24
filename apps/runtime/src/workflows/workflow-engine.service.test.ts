import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { Effect, Either, Layer } from 'effect';

import { cont, done, fail, suspend } from '@isagi/workflow-sdk';

import {
  AgentSessionArtifacts,
  AgentSessionService,
  HarnessLedgerObserver,
  type AgentSessionArtifactsService,
  type AgentSessionServiceShape,
  type AgentSessionHarnessMetadataRead,
  type ObservedHarnessTurnEdge,
  type HarnessLedgerObserverService,
} from '../agent-sessions/index.js';
import { DataDirectory, RuntimeDatabase, RuntimeDatabaseLive } from '../persistence/index.js';
import { workflowRunEvents, workflowRuns } from '../persistence/schema.js';
import { StateFile, stateFromActiveContext } from '../persistence/state-file.service.js';
import { makeTestDataDirectory } from '../persistence/test-support.js';
import { PtyService, type PtyServiceShape } from '../pty-processes/index.js';
import { InternalRuntimeEventBusLive } from '../runtime-events/index.js';
import { SurfaceService, type SurfaceServiceShape } from '../surfaces/index.js';
import { inject } from './context.js';
import { createWorkflowRegistry, WorkflowRegistry, WorkflowRegistryLive } from './registry.js';
import { WorkflowRepository, WorkflowRepositoryLive } from './repository.js';
import { resolveTurnEdge } from './resolver.js';
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

test('done(value) writes result_json and records reducer transition events', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-done-result-'));
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* WorkflowRegistry;
        yield* registry.addWorkflow('done-with-value', {
          initialState: { phase: 'start' },
          step: async () => done({ ok: true, count: 2 }),
        });
        const repository = yield* WorkflowRepository;
        const engine = yield* WorkflowEngine;
        const run = yield* repository.createRun({
          workflowKey: 'done-with-value',
          state: { phase: 'start' },
          stateVersion: 1,
        });

        yield* engine.drainOnce;
        const completed = yield* repository.findRun(run.id);
        const events = yield* listWorkflowRunEvents(run.id);
        return { completed, events };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(result.completed?.status, 'done');
    assert.deepEqual(JSON.parse(result.completed?.resultJson ?? '{}'), { ok: true, count: 2 });
    assert.deepEqual(
      result.events.map((event) => JSON.parse(event.trigger) as unknown),
      [{ kind: 'initial' }, { kind: 'done', hasValue: true }],
    );
    assert.deepEqual(
      result.events.map((event) => JSON.parse(event.state) as unknown),
      [{ phase: 'start' }, { phase: 'start' }],
    );
    assert.ok(result.events[0]!.id < result.events[1]!.id);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('returned fail(reason) marks failed and records a non-thrown failure event', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-returned-fail-'));
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* WorkflowRegistry;
        yield* registry.addWorkflow('returned-fail', {
          initialState: { phase: 'decide' },
          step: async (ctx) => {
            await ctx.setUiFeedback({ phase: 'failed' });
            return fail('workflow decided to stop');
          },
        });
        const repository = yield* WorkflowRepository;
        const engine = yield* WorkflowEngine;
        const run = yield* repository.createRun({
          workflowKey: 'returned-fail',
          state: { phase: 'decide' },
          stateVersion: 1,
        });

        yield* engine.drainOnce;
        const failed = yield* repository.findRun(run.id);
        const events = yield* listWorkflowRunEvents(run.id);
        return { failed, events };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(result.failed?.status, 'failed');
    assert.match(JSON.parse(result.failed?.error ?? '{}').message, /workflow decided to stop/);
    assert.deepEqual(JSON.parse(result.failed?.uiFeedback ?? '{}'), { phase: 'failed' });
    assert.deepEqual(JSON.parse(result.events.at(-1)?.trigger ?? '{}'), {
      kind: 'fail',
      thrown: false,
    });
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

test('drainOnce immediately resumes a turn suspend whose terminal edge already landed', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-suspend-race-'));
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const events: unknown[] = [];
        const registry = yield* WorkflowRegistry;
        yield* registry.addWorkflow('suspend-race-catchup', {
          initialState: { phase: 'arm' },
          step: async (_ctx, state, event) => {
            const current = state as { readonly phase: string };
            if (current.phase === 'arm') {
              return suspend(
                { phase: 'await_turn' },
                {
                  kind: 'turn',
                  agentSessionId: 10,
                  harnessSessionId: 'harness-a',
                  afterT: '2026-06-18T00:00:00.000Z',
                },
              );
            }
            events.push(event);
            return done();
          },
        });
        const repository = yield* WorkflowRepository;
        const engine = yield* WorkflowEngine;
        const run = yield* repository.createRun({
          workflowKey: 'suspend-race-catchup',
          state: { phase: 'arm' },
          stateVersion: 1,
        });

        yield* engine.drainOnce;
        const completed = yield* repository.findRun(run.id);
        return { completed, events };
      }).pipe(
        Effect.provide(
          testLayerWithResumeFakes(dataRoot, {
            metadataHarnessSessionId: 'harness-a',
            edges: [
              {
                type: 'turn_started',
                agentSessionId: 10,
                harnessSessionId: 'harness-a',
                seq: 0,
                recordedAt: '2026-06-18T00:00:01.000Z',
              },
              {
                type: 'turn_ended',
                agentSessionId: 10,
                harnessSessionId: 'harness-a',
                seq: 1,
                recordedAt: '2026-06-18T00:00:02.000Z',
              },
            ],
          }),
        ),
      ),
    );

    // The terminal edge already sat in the ledger when the step armed the wait, so
    // the post-suspend reconcile woke and resumed the run within the same drain
    // rather than stranding it in `waiting` for an event the lossy bus never replays.
    assert.equal(result.completed?.status, 'done');
    assert.equal(result.completed?.resumePayload, null);
    assert.deepEqual(result.events, [{ outcome: 'ended', recordedAt: '2026-06-18T00:00:02.000Z' }]);
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

test('thrown workflow step records a thrown failure event', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-thrown-event-'));
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* WorkflowRepository;
        const engine = yield* WorkflowEngine;
        const run = yield* repository.createRun({
          workflowKey: 'agentless-throws',
          state: { phase: 'before_throw' },
          stateVersion: 1,
        });

        yield* engine.drainOnce;
        const failed = yield* repository.findRun(run.id);
        const events = yield* listWorkflowRunEvents(run.id);
        return { failed, events };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(result.failed?.status, 'failed');
    assert.deepEqual(JSON.parse(result.events.at(-1)?.trigger ?? '{}'), {
      kind: 'fail',
      thrown: true,
    });
    assert.deepEqual(JSON.parse(result.events.at(-1)?.state ?? '{}'), {
      phase: 'before_throw',
    });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('deleting a workflow run cascades its event history', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-event-cascade-'));
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* WorkflowRepository;
        const run = yield* repository.createRun({
          workflowKey: 'agentless-cont-done',
          state: { phase: 'a', snapshots: ['a'] },
          stateVersion: 1,
        });
        yield* repository.completeCont({ runId: run.id, state: { phase: 'b' } });
        const before = yield* listWorkflowRunEvents(run.id);
        yield* deleteWorkflowRun(run.id);
        const after = yield* listWorkflowRunEvents(run.id);
        return { before, after };
      }).pipe(Effect.provide(repositoryOnlyLayer(dataRoot))),
    );

    assert.equal(result.before.length, 2);
    assert.deepEqual(result.after, []);
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

test('startup recoverer parks ready rows before the dispatcher startup drain', async () => {
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

    assert.equal(row?.status, 'paused');
    assert.deepEqual(JSON.parse(row?.stateJson ?? '{}'), { phase: 'ready_before_start' });
    assert.equal(row?.owner, null);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('startup recoverer parks non-terminal rows and preserves wait shape', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-startup-recoverer-'));
  try {
    const runId = await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* RuntimeDatabase;
        return yield* database.use('seed_waiting_workflow_before_engine_start', (db) => {
          const now = '2026-06-18T00:00:00.000Z';
          return db
            .insert(workflowRuns)
            .values({
              workflowKey: 'startup-fixture',
              worktreeId: null,
              surfaceId: null,
              status: 'waiting',
              waitKind: 'turn',
              waitCondition: JSON.stringify({
                kind: 'turn',
                agentSessionId: 10,
                harnessSessionId: 'harness-a',
                afterT: '2026-06-18T00:00:00.000Z',
              }),
              resumePayload: null,
              stateJson: JSON.stringify({ phase: 'waiting_before_start' }),
              stateVersion: 1,
              owner: 'dead-worker',
              uiFeedback: JSON.stringify({ phase: 'waiting' }),
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

    assert.equal(row?.status, 'paused');
    assert.equal(row?.owner, null);
    assert.equal(row?.waitKind, 'turn');
    assert.deepEqual(JSON.parse(row?.waitCondition ?? '{}'), {
      kind: 'turn',
      agentSessionId: 10,
      harnessSessionId: 'harness-a',
      afterT: '2026-06-18T00:00:00.000Z',
    });
    assert.deepEqual(JSON.parse(row?.stateJson ?? '{}'), { phase: 'waiting_before_start' });
    assert.deepEqual(JSON.parse(row?.uiFeedback ?? '{}'), { phase: 'waiting' });
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

test('resolver wakes waiting turn runs only after the condition watermark', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-resolver-'));
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* WorkflowRepository;
        const run = yield* repository.createRun({
          workflowKey: 'agentless-suspend',
          state: { phase: 'start' },
          stateVersion: 1,
        });
        yield* repository.completeSuspend({
          runId: run.id,
          state: { phase: 'waiting' },
          waitKind: 'turn',
          waitCondition: {
            kind: 'turn',
            agentSessionId: 10,
            harnessSessionId: 'harness-a',
            afterT: '2026-06-18T00:00:10.000Z',
          },
        });
        let pokes = 0;
        const engine = { poke: Effect.sync(() => void (pokes += 1)) };
        yield* resolveTurnEdge({
          repository,
          engine,
          edge: {
            type: 'turn_ended',
            agentSessionId: 10,
            harnessSessionId: 'harness-a',
            recordedAt: '2026-06-18T00:00:09.999Z',
          },
        });
        const before = yield* repository.findRun(run.id);
        yield* resolveTurnEdge({
          repository,
          engine,
          edge: {
            type: 'turn_ended',
            agentSessionId: 10,
            harnessSessionId: 'harness-a',
            recordedAt: '2026-06-18T00:00:10.000Z',
          },
        });
        const after = yield* repository.findRun(run.id);
        return { before, after, pokes };
      }).pipe(Effect.provide(repositoryOnlyLayer(dataRoot))),
    );

    assert.equal(result.before?.status, 'waiting');
    assert.equal(result.after?.status, 'ready');
    assert.equal(result.after?.waitKind, null);
    assert.equal(result.after?.waitCondition, null);
    assert.deepEqual(JSON.parse(result.after?.resumePayload ?? '{}'), {
      outcome: 'ended',
      recordedAt: '2026-06-18T00:00:10.000Z',
    });
    assert.equal(result.pokes, 1);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('step runner passes resume_payload as the workflow event and clears it on done', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-resume-event-'));
  try {
    const row = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* WorkflowRegistry;
        yield* registry.addWorkflow('resume-consumer', {
          initialState: { phase: 'unused' },
          step: async (_ctx, state, event) => {
            assert.deepEqual(state, { phase: 'await_turn' });
            assert.deepEqual(event, {
              outcome: 'ended',
              recordedAt: '2026-06-18T00:00:10.000Z',
            });
            return done();
          },
        });
        const repository = yield* WorkflowRepository;
        const engine = yield* WorkflowEngine;
        const run = yield* repository.createRun({
          workflowKey: 'resume-consumer',
          state: { phase: 'unused' },
          stateVersion: 1,
        });
        yield* repository.completeSuspend({
          runId: run.id,
          state: { phase: 'await_turn' },
          waitKind: 'turn',
          waitCondition: {
            kind: 'turn',
            agentSessionId: 10,
            harnessSessionId: 'harness-a',
            afterT: '2026-06-18T00:00:00.000Z',
          },
        });
        yield* resolveTurnEdge({
          repository,
          engine,
          edge: {
            type: 'turn_ended',
            agentSessionId: 10,
            harnessSessionId: 'harness-a',
            recordedAt: '2026-06-18T00:00:10.000Z',
          },
        });
        yield* engine.drainOnce;
        return yield* repository.findRun(run.id);
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(row?.status, 'done');
    assert.equal(row?.resumePayload, null);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('step runner marks failed when a resumed failed turn throws', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-resume-failed-'));
  try {
    const row = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* WorkflowRegistry;
        yield* registry.addWorkflow('resume-fails', {
          initialState: { phase: 'unused' },
          step: async (_ctx, _state, event) => {
            const payload = event as { readonly outcome?: string; readonly reason?: string };
            if (payload.outcome === 'failed') throw new Error(`turn failed: ${payload.reason}`);
            return done();
          },
        });
        const repository = yield* WorkflowRepository;
        const engine = yield* WorkflowEngine;
        const run = yield* repository.createRun({
          workflowKey: 'resume-fails',
          state: { phase: 'unused' },
          stateVersion: 1,
        });
        yield* repository.completeSuspend({
          runId: run.id,
          state: { phase: 'await_turn' },
          waitKind: 'turn',
          waitCondition: {
            kind: 'turn',
            agentSessionId: 10,
            harnessSessionId: 'harness-a',
            afterT: '2026-06-18T00:00:00.000Z',
          },
        });
        yield* resolveTurnEdge({
          repository,
          engine,
          edge: {
            type: 'turn_failed',
            agentSessionId: 10,
            harnessSessionId: 'harness-a',
            recordedAt: '2026-06-18T00:00:10.000Z',
            reason: 'new_start_supersedes',
          },
        });
        yield* engine.drainOnce;
        return yield* repository.findRun(run.id);
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(row?.status, 'failed');
    assert.match(JSON.parse(row?.error ?? '{}').message, /turn failed: new_start_supersedes/);
    assert.equal(row?.resumePayload, null);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('continueDevRun moves a paused null-wait run back to ready', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-continue-ready-'));
  try {
    const row = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* WorkflowRepository;
        const engine = yield* WorkflowEngine;
        const run = yield* repository.createRun({
          workflowKey: 'agentless-cont-done',
          state: { phase: 'a', snapshots: ['a'] },
          stateVersion: 1,
        });
        yield* repository.pauseNonTerminalRuns;
        yield* engine.continueDevRun({ runId: run.id });
        return yield* repository.findRun(run.id);
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(row?.status, 'ready');
    assert.equal(row?.waitKind, null);
    assert.equal(row?.waitCondition, null);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('continueDevRun reconciles a satisfied paused turn run to ready', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-continue-satisfied-'));
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
        yield* repository.completeSuspend({
          runId: run.id,
          state: { phase: 'waiting' },
          waitKind: 'turn',
          waitCondition: {
            kind: 'turn',
            agentSessionId: 10,
            harnessSessionId: 'harness-a',
            afterT: '2026-06-18T00:00:10.000Z',
          },
        });
        yield* repository.pauseNonTerminalRuns;
        yield* engine.continueDevRun({ runId: run.id });
        return yield* repository.findRun(run.id);
      }).pipe(
        Effect.provide(
          testLayerWithResumeFakes(dataRoot, {
            metadataHarnessSessionId: 'harness-a',
            edges: [
              {
                type: 'turn_started',
                agentSessionId: 10,
                harnessSessionId: 'other-harness',
                seq: 0,
                recordedAt: '2026-06-18T00:00:11.000Z',
              },
              {
                type: 'turn_ended',
                agentSessionId: 10,
                harnessSessionId: 'other-harness',
                seq: 1,
                recordedAt: '2026-06-18T00:00:12.000Z',
              },
              {
                type: 'turn_ended',
                agentSessionId: 10,
                harnessSessionId: 'harness-a',
                seq: 2,
                recordedAt: '2026-06-18T00:00:12.000Z',
              },
            ],
          }),
        ),
      ),
    );

    assert.equal(row?.status, 'ready');
    assert.equal(row?.waitKind, null);
    assert.equal(row?.waitCondition, null);
    assert.deepEqual(JSON.parse(row?.resumePayload ?? '{}'), {
      outcome: 'ended',
      recordedAt: '2026-06-18T00:00:12.000Z',
    });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('continueDevRun re-arms a paused turn run when no terminal edge satisfies it', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-continue-not-satisfied-'));
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
        yield* repository.completeSuspend({
          runId: run.id,
          state: { phase: 'waiting' },
          waitKind: 'turn',
          waitCondition: {
            kind: 'turn',
            agentSessionId: 10,
            harnessSessionId: 'harness-a',
            afterT: '2026-06-18T00:00:10.000Z',
          },
        });
        yield* repository.pauseNonTerminalRuns;
        yield* engine.continueDevRun({ runId: run.id });
        return yield* repository.findRun(run.id);
      }).pipe(
        Effect.provide(
          testLayerWithResumeFakes(dataRoot, {
            metadataHarnessSessionId: 'harness-a',
            edges: [
              {
                type: 'turn_started',
                agentSessionId: 10,
                harnessSessionId: 'harness-a',
                seq: 0,
                recordedAt: '2026-06-18T00:00:11.000Z',
              },
            ],
          }),
        ),
      ),
    );

    assert.equal(row?.status, 'waiting');
    assert.equal(row?.waitKind, 'turn');
    assert.equal(row?.resumePayload, null);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('continueDevRun fails a paused turn run when the harness session pin mismatches', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-continue-pin-mismatch-'));
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
        yield* repository.completeSuspend({
          runId: run.id,
          state: { phase: 'waiting' },
          waitKind: 'turn',
          waitCondition: {
            kind: 'turn',
            agentSessionId: 10,
            harnessSessionId: 'harness-a',
            afterT: '2026-06-18T00:00:10.000Z',
          },
        });
        yield* repository.pauseNonTerminalRuns;
        yield* engine.continueDevRun({ runId: run.id });
        return yield* repository.findRun(run.id);
      }).pipe(
        Effect.provide(
          testLayerWithResumeFakes(dataRoot, {
            metadataHarnessSessionId: 'harness-b',
            edges: [],
          }),
        ),
      ),
    );

    assert.equal(row?.status, 'failed');
    assert.match(JSON.parse(row?.error ?? '{}').message, /harness session pin mismatch/);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('continueDevRun fails unsupported paused wait kinds with a diagnostic', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-continue-unsupported-'));
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
        yield* repository.completeSuspend({
          runId: run.id,
          state: { phase: 'waiting' },
          waitKind: 'user_input',
          waitCondition: { kind: 'user_input', questions: [] },
        });
        yield* repository.pauseNonTerminalRuns;
        yield* engine.continueDevRun({ runId: run.id });
        return yield* repository.findRun(run.id);
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(row?.status, 'failed');
    assert.match(
      JSON.parse(row?.error ?? '{}').message,
      /unsupported workflow continue wait_kind/i,
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('inject resolves the active agent PTY and writes bracketed paste plus enter', async () => {
  const writes: Array<{ ptyProcessId: number; data: string }> = [];
  await Effect.runPromise(
    inject({
      agents: {
        ...fakeAgentSessionService(),
        activePtyProcessId: () => Effect.succeed(20),
      },
      pty: {
        ...fakePtyService(),
        writeInput: (input) =>
          Effect.sync(() => {
            writes.push(input);
          }),
      },
      agentSessionId: 10,
      text: 'line 1\r\nline 2',
    }),
  );

  assert.deepEqual(writes, [
    { ptyProcessId: 20, data: '\x1b[200~line 1\nline 2\x1b[201~' },
    { ptyProcessId: 20, data: '\r' },
  ]);
});

const listWorkflowRuns = Effect.gen(function* () {
  const database = yield* RuntimeDatabase;
  return yield* database.use('test_list_workflow_runs', (db) =>
    db.select().from(workflowRuns).all(),
  );
});

function listWorkflowRunEvents(runId: number) {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    return yield* database.use('test_list_workflow_run_events', (db) =>
      db
        .select()
        .from(workflowRunEvents)
        .where(eq(workflowRunEvents.workflowRunId, runId))
        .orderBy(workflowRunEvents.id)
        .all(),
    );
  });
}

function deleteWorkflowRun(runId: number) {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    yield* database.use('test_delete_workflow_run', (db) => {
      db.delete(workflowRuns).where(eq(workflowRuns.id, runId)).run();
    });
  });
}

function testLayer(dataRoot: string) {
  return workflowLayer(dataRoot, WorkflowRegistryLive);
}

function testLayerWithResumeFakes(
  dataRoot: string,
  input: {
    readonly metadataHarnessSessionId: string | null;
    readonly edges: readonly ObservedHarnessTurnEdge[];
  },
) {
  return workflowLayer(dataRoot, WorkflowRegistryLive, {
    artifacts: fakeAgentSessionArtifacts({
      status: 'valid',
      metadata: {
        schemaVersion: 1,
        harnessSessionId: input.metadataHarnessSessionId,
        updatedAt: '2026-06-18T00:00:00.000Z',
      },
      metadataPath: '',
    }),
    observer: fakeHarnessLedgerObserver(input.edges),
  });
}

function repositoryOnlyLayer(dataRoot: string) {
  const database = databaseLayer(dataRoot);
  const repository = WorkflowRepositoryLive.pipe(Layer.provide(database));
  return Layer.mergeAll(repository, database);
}

function workflowLayer(
  dataRoot: string,
  registry: Layer.Layer<import('./registry.js').WorkflowRegistryService>,
  fakes: {
    readonly artifacts?: AgentSessionArtifactsService | undefined;
    readonly observer?: HarnessLedgerObserverService | undefined;
  } = {},
) {
  const database = databaseLayer(dataRoot);
  const repository = WorkflowRepositoryLive.pipe(Layer.provide(database));
  const stateFile = Layer.succeed(StateFile, {
    read: Effect.succeed(stateFromActiveContext(1, 10, 1)),
    write: () => Effect.void,
    writeActiveContextIfFresh: () => Effect.succeed(stateFromActiveContext(1, 10, 1)),
  });
  const engine = WorkflowEngineLive.pipe(
    Layer.provide(repository),
    Layer.provide(registry),
    Layer.provide(stateFile),
    Layer.provide(InternalRuntimeEventBusLive),
    Layer.provide(Layer.succeed(AgentSessionService, fakeAgentSessionService())),
    Layer.provide(Layer.succeed(SurfaceService, fakeSurfaceService())),
    Layer.provide(Layer.succeed(PtyService, fakePtyService())),
    Layer.provide(
      Layer.succeed(AgentSessionArtifacts, fakes.artifacts ?? fakeAgentSessionArtifacts()),
    ),
    Layer.provide(
      Layer.succeed(HarnessLedgerObserver, fakes.observer ?? fakeHarnessLedgerObserver()),
    ),
  );
  return Layer.mergeAll(engine, repository, registry, database, stateFile);
}

function databaseLayer(dataRoot: string) {
  return RuntimeDatabaseLive.pipe(
    Layer.provide(Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot))),
  );
}

function fakeAgentSessionService(): AgentSessionServiceShape {
  return {
    startFresh: () => Effect.die('agent startFresh is not used'),
    get: () => Effect.die('agent get is not used'),
    ensureActivePtyProcess: () => Effect.die('agent ensureActivePtyProcess is not used'),
    activePtyProcessId: () => Effect.die('agent activePtyProcessId is not used'),
  };
}

function fakeSurfaceService(): SurfaceServiceShape {
  return {
    getSurfaceDetail: () => Effect.die('surface getSurfaceDetail is not used'),
    renameSurface: () => Effect.die('surface renameSurface is not used'),
    deleteSurface: () => Effect.die('surface deleteSurface is not used'),
    deleteSurfacePane: () => Effect.die('surface deleteSurfacePane is not used'),
    createSurface: () => Effect.die('surface createSurface is not used'),
    splitPane: () => Effect.die('surface splitPane is not used'),
    setSplitWeights: () => Effect.die('surface setSplitWeights is not used'),
    createPaneSession: () => Effect.die('surface createPaneSession is not used'),
    claimPaneSession: () => Effect.die('surface claimPaneSession is not used'),
    createSinglePaneSurface: () => Effect.die('surface createSinglePaneSurface is not used'),
    setWorktreeEnvironmentFocus: () =>
      Effect.die('surface setWorktreeEnvironmentFocus is not used'),
  };
}

function fakePtyService(): PtyServiceShape {
  return {
    launch: () => Effect.die('pty launch is not used'),
    getAttachmentPlan: () => Effect.die('pty getAttachmentPlan is not used'),
    attach: () => Effect.die('pty attach is not used'),
    replay: () => Effect.die('pty replay is not used'),
    write: () => Effect.die('pty write is not used'),
    writeInput: () => Effect.die('pty writeInput is not used'),
    resize: () => Effect.die('pty resize is not used'),
    kill: () => Effect.die('pty kill is not used'),
    terminate: () => Effect.die('pty terminate is not used'),
  };
}

function fakeAgentSessionArtifacts(
  metadata: AgentSessionHarnessMetadataRead | null = null,
): AgentSessionArtifactsService {
  return {
    paths: () => ({ directory: '', metadataPath: '' }),
    initializeMetadata: () => Effect.die('artifacts initializeMetadata is not used'),
    prepareProcessArtifacts: () => Effect.die('artifacts prepareProcessArtifacts is not used'),
    readMetadata: () =>
      metadata ? Effect.succeed(metadata) : Effect.die('artifacts readMetadata is not used'),
    readJsonlForAgentSession: () => Effect.die('artifacts readJsonlForAgentSession is not used'),
    listAgentSessionIds: Effect.succeed([]),
    writeHarnessSessionId: () => Effect.die('artifacts writeHarnessSessionId is not used'),
    removeDirectory: () => Effect.die('artifacts removeDirectory is not used'),
  };
}

function fakeHarnessLedgerObserver(
  edges: readonly ObservedHarnessTurnEdge[] = [],
): HarnessLedgerObserverService {
  return {
    reconcileAgentSession: () => Effect.void,
    getProjection: () => Effect.succeed(undefined),
    getTurnEdges: () => Effect.succeed(edges),
  };
}
