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
import {
  projects,
  surfacePanes,
  workflowRunEvents,
  workflowRuns,
  worktreeSurfaces,
  worktrees,
} from '../persistence/schema.js';
import { StateFile, stateFromActiveContext } from '../persistence/state-file.service.js';
import { makeTestDataDirectory } from '../persistence/test-support.js';
import { PtyService, type PtyServiceShape } from '../pty-processes/index.js';
import { InternalRuntimeEventBusLive } from '../runtime-events/index.js';
import {
  SurfaceService,
  type PtyProcessRecord,
  type SurfaceServiceShape,
} from '../surfaces/index.js';
import { WorkspaceRepository, type WorkspaceRepositoryService } from '../workspace/index.js';
import { chooseSpawnSplit, inject, workflowContext } from './context.js';
import { WorkflowHeadless, type WorkflowHeadlessService } from './headless.js';
import { createWorkflowRegistry, WorkflowRegistry } from './registry.js';
import { WorkflowRepository, WorkflowRepositoryLive } from './repository.js';
import type { WorkflowRepositoryService } from './repository.js';
import { resolveTurnEdge } from './resolver.js';
import { WorkflowEngineError, type WorkflowRunRow } from './types.js';
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
          worktreeId: 1,
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
      kind: 'info',
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
          command: () => ({ title: 'Done with value' }),
          validate: () => {},
          init: () => ({ phase: 'start' }),
          step: async () => done({ ok: true, count: 2 }),
        });
        const repository = yield* WorkflowRepository;
        const engine = yield* WorkflowEngine;
        const run = yield* repository.createRun({
          workflowKey: 'done-with-value',
          state: { phase: 'start' },
          stateVersion: 1,
          worktreeId: 1,
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
          command: () => ({ title: 'Returned fail' }),
          validate: () => {},
          init: () => ({ phase: 'decide' }),
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
          worktreeId: 1,
        });

        yield* engine.drainOnce;
        const failed = yield* repository.findRun(run.id);
        const events = yield* listWorkflowRunEvents(run.id);
        return { failed, events };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(result.failed?.status, 'failed');
    assert.match(JSON.parse(result.failed?.error ?? '{}').message, /workflow decided to stop/);
    assert.deepEqual(JSON.parse(result.failed?.uiFeedback ?? '{}'), {
      kind: 'info',
      phase: 'failed',
    });
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
          worktreeId: 1,
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
          command: () => ({ title: 'Suspend race catchup' }),
          validate: () => {},
          init: () => ({ phase: 'arm' }),
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
          worktreeId: 1,
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

test('drainOnce immediately resumes a headless suspend whose op already completed', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-headless-race-'));
  const released: string[][] = [];
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* WorkflowRegistry;
        yield* registry.addWorkflow('headless-race-catchup', {
          command: () => ({ title: 'Headless race catchup' }),
          validate: () => {},
          init: () => ({ phase: 'arm' }),
          step: async (ctx, state, event) => {
            const current = state as { readonly phase: string };
            if (current.phase === 'arm') {
              const op = await ctx.runHeadlessPrompt({
                harness: 'claude',
                prompt: 'reply ok',
                timeoutMs: 30_000,
              });
              return suspend({ phase: 'await_headless' }, { kind: 'headless', ops: [op] });
            }
            return done(event);
          },
        });
        const repository = yield* WorkflowRepository;
        const engine = yield* WorkflowEngine;
        const run = yield* repository.createRun({
          workflowKey: 'headless-race-catchup',
          state: { phase: 'arm' },
          stateVersion: 1,
          worktreeId: 1,
        });

        const summary = yield* engine.drainOnce;
        const completed = yield* repository.findRun(run.id);
        return { summary, completed };
      }).pipe(
        Effect.provide(
          workflowLayer(dataRoot, Layer.succeed(WorkflowRegistry, createWorkflowRegistry()), {
            headless: fakeWorkflowHeadless({
              runHeadlessPrompt: () =>
                Effect.succeed({
                  opId: 'headless:op-1',
                  launch: {
                    harness: 'claude',
                    prompt: 'reply ok',
                    timeoutMs: 30_000,
                  },
                }),
              completedResults: () =>
                Effect.succeed([
                  {
                    opId: 'headless:op-1',
                    status: 'completed',
                    output: 'ok',
                    exitCode: 0,
                  },
                ]),
              releaseOps: (input) =>
                Effect.sync(() => {
                  released.push([...input.opIds]);
                }),
            }),
          }),
        ),
      ),
    );

    assert.equal(result.summary.claimed, 2);
    assert.equal(result.completed?.status, 'done');
    // The consumed op is evicted from the tracker once its result is delivered.
    assert.deepEqual(released, [['headless:op-1']]);
    assert.deepEqual(JSON.parse(result.completed?.resultJson ?? '{}'), {
      kind: 'headless',
      results: [
        {
          opId: 'headless:op-1',
          status: 'completed',
          output: 'ok',
          exitCode: 0,
        },
      ],
    });
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
          command: () => ({ title: 'Feedback then throws' }),
          validate: () => {},
          init: () => ({ phase: 'before_throw' }),
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
          worktreeId: 1,
        });

        yield* engine.drainOnce;
        return yield* repository.findRun(run.id);
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(row?.status, 'failed');
    assert.deepEqual(JSON.parse(row?.stateJson ?? '{}'), { phase: 'before_throw' });
    assert.deepEqual(JSON.parse(row?.uiFeedback ?? '{}'), { kind: 'info', phase: 'throwing' });
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
          worktreeId: 1,
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
          worktreeId: 1,
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
          worktreeId: 1,
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

test('startWorkflow rejects unknown workflow keys before insert', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-unknown-start-'));
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine;
        const started = yield* engine
          .startWorkflow({
            workflowKey: 'missing',
            variables: {},
            context: { worktreeId: 1, surfaceId: 1 },
          })
          .pipe(Effect.either);
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

test('startWorkflow validates context and seeds state through init', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-start-context-'));
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* WorkflowRegistry;
        yield* registry.addWorkflow('context-seeded', {
          command: () => ({ title: 'Context seeded' }),
          validate: (ctx, variables) => {
            assert.equal(ctx.worktreePath, '/tmp/isagi-test-worktree');
            assert.equal(ctx.paneId, 7);
            assert.equal(ctx.agentSessionId, 10);
            assert.equal(variables.mode, 'dogfood');
          },
          init: (ctx, variables) => ({
            phase: 'seeded',
            worktreePath: ctx.worktreePath,
            paneId: ctx.paneId,
            agentSessionId: ctx.agentSessionId,
            mode: variables.mode,
          }),
          step: async (_ctx, state) => done(state),
        });
        const engine = yield* WorkflowEngine;
        const run = yield* engine.startWorkflow({
          workflowKey: 'context-seeded',
          variables: { mode: 'dogfood' },
          context: { worktreeId: 1, surfaceId: 1, paneId: 7 },
        });
        return run;
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(result.worktreeId, 1);
    assert.equal(result.surfaceId, 1);
    assert.deepEqual(JSON.parse(result.stateJson), {
      phase: 'seeded',
      worktreePath: '/tmp/isagi-test-worktree',
      paneId: 7,
      agentSessionId: 10,
      mode: 'dogfood',
    });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('startWorkflow validation failure creates no run row', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-start-validation-'));
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* WorkflowRegistry;
        yield* registry.addWorkflow('rejects', {
          command: () => ({ title: 'Rejects' }),
          validate: () => {
            throw new Error('Nope.');
          },
          init: () => ({ phase: 'should_not_run' }),
          step: async () => done(),
        });
        const engine = yield* WorkflowEngine;
        const started = yield* engine
          .startWorkflow({
            workflowKey: 'rejects',
            variables: {},
            context: { worktreeId: 1, surfaceId: 1 },
          })
          .pipe(Effect.either);
        const rows = yield* listWorkflowRuns;
        return { started, rows };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.ok(Either.isLeft(result.started));
    assert.ok(result.started.left instanceof WorkflowEngineError);
    assert.equal(result.started.left.code, 'validation_failed');
    assert.deepEqual(result.rows, []);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('workflow ctx startWorkflow creates a same-worktree child with explicit agent launch context', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-composed-start-'));
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* WorkflowRegistry;
        yield* registry.addWorkflow('child-context', {
          command: () => ({ title: 'Child context' }),
          validate: (ctx, variables) => {
            assert.equal(ctx.worktreeId, 1);
            assert.equal(ctx.surfaceId, 1);
            assert.equal(ctx.paneId, 7);
            assert.equal(ctx.agentSessionId, 10);
            assert.equal(variables.fromParent, true);
          },
          init: (ctx) => ({
            phase: 'child',
            agentSessionId: ctx.agentSessionId,
            paneId: ctx.paneId,
          }),
          step: async (_ctx, state) => done(state),
        });
        yield* registry.addWorkflow('parent-starts-child', {
          command: () => ({ title: 'Parent starts child' }),
          validate: () => {},
          init: () => ({ phase: 'start' }),
          step: async (ctx) => {
            const childRunId = await ctx.startWorkflow(
              'child-context',
              { fromParent: true },
              { agentSessionId: 10 },
            );
            return done({ childRunId });
          },
        });
        const engine = yield* WorkflowEngine;
        const parent = yield* engine.startWorkflow({
          workflowKey: 'parent-starts-child',
          variables: {},
          context: { worktreeId: 1, surfaceId: 1, paneId: 7 },
        });
        yield* drainEngineUntilSettled(engine);
        const rows = yield* listWorkflowRuns;
        return { parent, rows };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    const parent = result.rows.find((run) => run.id === result.parent.id);
    assert.equal(parent?.status, 'done');
    const parentResult = JSON.parse(parent?.resultJson ?? '{}') as { childRunId: number };
    const child = result.rows.find((run) => run.id === parentResult.childRunId);
    assert.equal(child?.workflowKey, 'child-context');
    assert.equal(child?.worktreeId, 1);
    assert.equal(child?.surfaceId, 1);
    assert.deepEqual(JSON.parse(child?.stateJson ?? '{}'), {
      phase: 'child',
      agentSessionId: 10,
      paneId: 7,
    });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('workflow ctx startWorkflow rejects agent sessions outside the target surface', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-composed-start-invalid-agent-'));
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* WorkflowRegistry;
        yield* registry.addWorkflow('child-never-starts', {
          command: () => ({ title: 'Child never starts' }),
          validate: () => {},
          init: () => ({ phase: 'child' }),
          step: async () => done(),
        });
        yield* registry.addWorkflow('parent-invalid-agent', {
          command: () => ({ title: 'Parent invalid agent' }),
          validate: () => {},
          init: () => ({ phase: 'start' }),
          step: async (ctx) => {
            await ctx.startWorkflow('child-never-starts', {}, { agentSessionId: 999 });
            return done();
          },
        });
        const engine = yield* WorkflowEngine;
        const parent = yield* engine.startWorkflow({
          workflowKey: 'parent-invalid-agent',
          variables: {},
          context: { worktreeId: 1, surfaceId: 1, paneId: 7 },
        });
        yield* drainEngineUntilSettled(engine);
        const rows = yield* listWorkflowRuns;
        return { parent, rows };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    const parent = result.rows.find((run) => run.id === result.parent.id);
    assert.equal(parent?.status, 'failed');
    assert.match(JSON.parse(parent?.error ?? '{}').message, /Agent session 999/);
    assert.equal(result.rows.filter((run) => run.workflowKey === 'child-never-starts').length, 0);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('workflow JOIN resumes with child results in input order after all children terminate', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-join-order-'));
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* WorkflowRegistry;
        yield* registry.addWorkflow('child-one', {
          command: () => ({ title: 'Child one' }),
          validate: () => {},
          init: () => ({ phase: 'start' }),
          step: async () => done({ child: 'one' }),
        });
        yield* registry.addWorkflow('child-two', {
          command: () => ({ title: 'Child two' }),
          validate: () => {},
          init: () => ({ phase: 'start' }),
          step: async () => done({ child: 'two' }),
        });
        yield* registry.addWorkflow('parent-join', {
          command: () => ({ title: 'Parent join' }),
          validate: () => {},
          init: () => ({ phase: 'start' }),
          step: async (ctx, state, event) => {
            const current = state as { readonly phase: 'start' | 'waiting' };
            if (current.phase === 'start') {
              const second = await ctx.startWorkflow('child-two');
              const first = await ctx.startWorkflow('child-one');
              return suspend({ phase: 'waiting' }, { kind: 'workflow', runIds: [first, second] });
            }
            return done(event);
          },
        });
        const engine = yield* WorkflowEngine;
        const parent = yield* engine.startWorkflow({
          workflowKey: 'parent-join',
          variables: {},
          context: { worktreeId: 1, surfaceId: 1, paneId: 7 },
        });
        yield* drainEngineUntilSettled(engine);
        const completed = yield* WorkflowRepository.pipe(
          Effect.flatMap((repository) => repository.findRun(parent.id)),
        );
        return completed;
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(result?.status, 'done');
    assert.deepEqual(JSON.parse(result?.resultJson ?? '{}'), {
      kind: 'workflow',
      results: [
        { runId: 3, status: 'done', result: { child: 'one' } },
        { runId: 2, status: 'done', result: { child: 'two' } },
      ],
    });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('workflow JOIN delivers failed child errors instead of failing the parent automatically', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-join-failed-child-'));
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* WorkflowRegistry;
        yield* registry.addWorkflow('child-fails', {
          command: () => ({ title: 'Child fails' }),
          validate: () => {},
          init: () => ({ phase: 'start' }),
          step: async () => fail('child returned failure'),
        });
        yield* registry.addWorkflow('parent-observes-failed-child', {
          command: () => ({ title: 'Parent observes failed child' }),
          validate: () => {},
          init: () => ({ phase: 'start' }),
          step: async (ctx, state, event) => {
            const current = state as { readonly phase: 'start' | 'waiting' };
            if (current.phase === 'start') {
              const childRunId = await ctx.startWorkflow('child-fails');
              return suspend({ phase: 'waiting' }, { kind: 'workflow', runIds: [childRunId] });
            }
            return done(event);
          },
        });
        const engine = yield* WorkflowEngine;
        const parent = yield* engine.startWorkflow({
          workflowKey: 'parent-observes-failed-child',
          variables: {},
          context: { worktreeId: 1, surfaceId: 1, paneId: 7 },
        });
        yield* drainEngineUntilSettled(engine);
        const repository = yield* WorkflowRepository;
        return yield* repository.findRun(parent.id);
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(result?.status, 'done');
    const payload = JSON.parse(result?.resultJson ?? '{}') as {
      readonly results: readonly {
        readonly status: string;
        readonly error?: { message: string };
      }[];
    };
    assert.equal(payload.results[0]?.status, 'failed');
    assert.match(payload.results[0]?.error?.message ?? '', /child returned failure/);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('workflow JOIN fails loudly when a referenced run id is missing', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-join-missing-'));
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* WorkflowRegistry;
        yield* registry.addWorkflow('parent-missing-child', {
          command: () => ({ title: 'Parent missing child' }),
          validate: () => {},
          init: () => ({ phase: 'start' }),
          step: async () => suspend({ phase: 'waiting' }, { kind: 'workflow', runIds: [9999] }),
        });
        const engine = yield* WorkflowEngine;
        const parent = yield* engine.startWorkflow({
          workflowKey: 'parent-missing-child',
          variables: {},
          context: { worktreeId: 1, surfaceId: 1, paneId: 7 },
        });
        yield* engine.drainOnce;
        const repository = yield* WorkflowRepository;
        return yield* repository.findRun(parent.id);
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(result?.status, 'failed');
    assert.match(JSON.parse(result?.error ?? '{}').message, /missing workflow run 9999/);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('workflow JOIN arm-time reconcile resumes when children are already terminal', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-join-arm-catchup-'));
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* WorkflowRegistry;
        yield* registry.addWorkflow('parent-existing-child', {
          command: () => ({ title: 'Parent existing child' }),
          validate: () => {},
          init: (_ctx, variables) => ({
            phase: 'start',
            childRunId: Number(variables.childRunId),
          }),
          step: async (_ctx, state, event) => {
            const current = state as {
              readonly phase: 'start' | 'waiting';
              readonly childRunId: number;
            };
            if (current.phase === 'start') {
              return suspend(
                { phase: 'waiting', childRunId: current.childRunId },
                { kind: 'workflow', runIds: [current.childRunId] },
              );
            }
            return done(event);
          },
        });
        const repository = yield* WorkflowRepository;
        const child = yield* repository.createRun({
          workflowKey: 'already-done-child',
          state: { phase: 'done' },
          stateVersion: 1,
          worktreeId: 1,
          surfaceId: 1,
        });
        yield* repository.completeDone({
          runId: child.id,
          state: { phase: 'done' },
          value: { child: 'already done' },
        });
        const engine = yield* WorkflowEngine;
        const parent = yield* engine.startWorkflow({
          workflowKey: 'parent-existing-child',
          variables: { childRunId: child.id },
          context: { worktreeId: 1, surfaceId: 1, paneId: 7 },
        });
        yield* drainEngineUntilSettled(engine);
        return yield* repository.findRun(parent.id);
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(result?.status, 'done');
    assert.deepEqual(JSON.parse(result?.resultJson ?? '{}'), {
      kind: 'workflow',
      results: [{ runId: 1, status: 'done', result: { child: 'already done' } }],
    });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('recovery continue resolves paused workflow JOINs from workflow_runs truth', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-join-recovery-'));
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* WorkflowRepository;
        const engine = yield* WorkflowEngine;
        const first = yield* repository.createRun({
          workflowKey: 'child-a',
          state: { phase: 'done' },
          stateVersion: 1,
          worktreeId: 1,
          surfaceId: 1,
        });
        const second = yield* repository.createRun({
          workflowKey: 'child-b',
          state: { phase: 'done' },
          stateVersion: 1,
          worktreeId: 1,
          surfaceId: 1,
        });
        yield* repository.completeDone({ runId: first.id, state: {}, value: { child: 'a' } });
        yield* repository.completeDone({ runId: second.id, state: {}, value: { child: 'b' } });
        const parent = yield* repository.createRun({
          workflowKey: 'parent',
          state: { phase: 'waiting' },
          stateVersion: 1,
          worktreeId: 1,
          surfaceId: 1,
        });
        yield* repository.completeSuspend({
          runId: parent.id,
          state: { phase: 'waiting' },
          waitKind: 'workflow',
          waitCondition: { kind: 'workflow', runIds: [second.id, first.id] },
        });
        yield* repository.pauseNonTerminalRuns;
        const continued = yield* engine.continueDevRun({ runId: parent.id });
        const readied = yield* repository.findRun(parent.id);
        return { continued, readied };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(result.continued.status, 'ready');
    assert.equal(result.readied?.status, 'ready');
    assert.deepEqual(JSON.parse(result.readied?.resumePayload ?? '{}'), {
      kind: 'workflow',
      results: [
        { runId: 2, status: 'done', result: { child: 'b' } },
        { runId: 1, status: 'done', result: { child: 'a' } },
      ],
    });
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
                  command: () => ({ title: 'Startup fixture' }),
                  validate: () => {},
                  init: () => ({ phase: 'unused' }),
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
                  command: () => ({ title: 'Startup fixture' }),
                  validate: () => {},
                  init: () => ({ phase: 'unused' }),
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
          worktreeId: 1,
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
          command: () => ({ title: 'Feedback then cont' }),
          validate: () => {},
          init: () => ({ phase: 'set_feedback' }),
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
          worktreeId: 1,
        });

        yield* engine.drainOnce;
        return yield* repository.findRun(run.id);
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(row?.status, 'done');
    assert.deepEqual(JSON.parse(row?.uiFeedback ?? '{}'), { kind: 'info', phase: 'set' });
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
          worktreeId: 1,
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
          command: () => ({ title: 'Resume consumer' }),
          validate: () => {},
          init: () => ({ phase: 'unused' }),
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
          worktreeId: 1,
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
          command: () => ({ title: 'Resume fails' }),
          validate: () => {},
          init: () => ({ phase: 'unused' }),
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
          worktreeId: 1,
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
          worktreeId: 1,
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
          worktreeId: 1,
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
          worktreeId: 1,
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
          worktreeId: 1,
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

test('continueDevRun re-arms paused human waits without satisfying them', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-continue-human-wait-'));
  try {
    const row = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* WorkflowRepository;
        const engine = yield* WorkflowEngine;
        const run = yield* repository.createRun({
          workflowKey: 'agentless-suspend',
          state: { phase: 'start' },
          stateVersion: 1,
          worktreeId: 1,
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

    assert.equal(row?.status, 'waiting');
    assert.equal(row?.waitKind, 'user_input');
    assert.deepEqual(JSON.parse(row?.waitCondition ?? '{}'), {
      kind: 'user_input',
      questions: [],
    });
    assert.equal(row?.resumePayload, null);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('continueDevRun reissues paused headless waits without changing the persisted opId', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-continue-headless-wait-'));
  const reissues: unknown[] = [];
  try {
    const row = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* WorkflowRepository;
        const engine = yield* WorkflowEngine;
        const run = yield* repository.createRun({
          workflowKey: 'agentless-suspend',
          state: { phase: 'start' },
          stateVersion: 1,
          worktreeId: 1,
        });
        yield* repository.completeSuspend({
          runId: run.id,
          state: { phase: 'waiting' },
          waitKind: 'headless',
          waitCondition: {
            kind: 'headless',
            ops: [
              {
                opId: 'headless:stable-op',
                launch: {
                  harness: 'codex',
                  prompt: 'inspect',
                  timeoutMs: 600_000,
                },
              },
            ],
          },
        });
        yield* repository.pauseNonTerminalRuns;
        yield* engine.continueDevRun({ runId: run.id });
        return yield* repository.findRun(run.id);
      }).pipe(
        Effect.provide(
          workflowLayer(dataRoot, Layer.succeed(WorkflowRegistry, createWorkflowRegistry()), {
            headless: fakeWorkflowHeadless({
              completedResults: () => Effect.succeed(null),
              reissue: (input) =>
                Effect.sync(() => {
                  reissues.push(input);
                }),
            }),
          }),
        ),
      ),
    );

    assert.equal(row?.status, 'waiting');
    assert.equal(row?.waitKind, 'headless');
    assert.deepEqual(JSON.parse(row?.waitCondition ?? '{}'), {
      kind: 'headless',
      ops: [
        {
          opId: 'headless:stable-op',
          launch: {
            harness: 'codex',
            prompt: 'inspect',
            timeoutMs: 600_000,
          },
        },
      ],
    });
    assert.deepEqual(reissues, [
      {
        runId: row?.id,
        worktreePath: '/tmp/isagi-test-worktree',
        ops: [
          {
            opId: 'headless:stable-op',
            launch: {
              harness: 'codex',
              prompt: 'inspect',
              timeoutMs: 600_000,
            },
          },
        ],
      },
    ]);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('satisfyUserContinueDevRun wakes a waiting user_continue run with a tagged event', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-user-continue-'));
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const events: unknown[] = [];
        const registry = yield* WorkflowRegistry;
        yield* registry.addWorkflow('human-continue', {
          command: () => ({ title: 'Human continue' }),
          validate: () => {},
          init: () => ({ phase: 'arm' }),
          step: async (_ctx, state, event) => {
            const current = state as { readonly phase: string };
            if (current.phase === 'arm') {
              return suspend({ phase: 'await_continue' }, { kind: 'user_continue' });
            }
            events.push(event);
            return done();
          },
        });
        const repository = yield* WorkflowRepository;
        const engine = yield* WorkflowEngine;
        const run = yield* repository.createRun({
          workflowKey: 'human-continue',
          state: { phase: 'arm' },
          stateVersion: 1,
          worktreeId: 1,
        });

        yield* engine.drainOnce;
        const waiting = yield* repository.findRun(run.id);
        const satisfied = yield* engine.satisfyUserContinueDevRun({ runId: run.id });
        yield* engine.drainOnce;
        const completed = yield* repository.findRun(run.id);
        return { waiting, satisfied, completed, events };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(result.waiting?.status, 'waiting');
    assert.equal(result.waiting?.waitKind, 'user_continue');
    assert.equal(result.satisfied.outcome, 'satisfied');
    assert.equal(result.completed?.status, 'done');
    assert.deepEqual(result.events, [{ kind: 'user_continue' }]);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('satisfyUserContinueDevRun treats no-longer-waiting runs as already resolved', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-user-continue-race-'));
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* WorkflowRepository;
        const engine = yield* WorkflowEngine;
        const run = yield* repository.createRun({
          workflowKey: 'agentless-cont-done',
          state: { phase: 'a', snapshots: ['a'] },
          stateVersion: 1,
          worktreeId: 1,
        });
        return yield* engine.satisfyUserContinueDevRun({ runId: run.id });
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(result.outcome, 'already_resolved');
    assert.equal(result.run.status, 'ready');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('submitUserInputDevRun validates answers against persisted questions and applies defaults', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-user-input-'));
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const events: unknown[] = [];
        const registry = yield* WorkflowRegistry;
        yield* registry.addWorkflow('human-input', {
          command: () => ({ title: 'Human input' }),
          validate: () => {},
          init: () => ({ phase: 'arm' }),
          step: async (_ctx, state, event) => {
            const current = state as { readonly phase: string };
            if (current.phase === 'arm') {
              return suspend(
                { phase: 'await_input' },
                {
                  kind: 'user_input',
                  questions: [
                    { kind: 'text', key: 'summary', label: 'Summary' },
                    {
                      kind: 'select',
                      key: 'risk',
                      label: 'Risk',
                      options: [{ value: 'low' }, { value: 'high' }],
                      default: 'low',
                    },
                    { kind: 'confirm', key: 'approved', label: 'Approved', default: false },
                  ],
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
          workflowKey: 'human-input',
          state: { phase: 'arm' },
          stateVersion: 1,
          worktreeId: 1,
        });

        yield* engine.drainOnce;
        const satisfied = yield* engine.submitUserInputDevRun({
          runId: run.id,
          answers: { summary: 'Ship it' },
        });
        yield* engine.drainOnce;
        const completed = yield* repository.findRun(run.id);
        return { satisfied, completed, events };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(result.satisfied.outcome, 'satisfied');
    assert.equal(result.completed?.status, 'done');
    assert.deepEqual(result.events, [
      {
        kind: 'user_input',
        answers: { summary: 'Ship it', risk: 'low', approved: false },
      },
    ]);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('submitUserInputDevRun rejects invalid answers and leaves the run waiting', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-user-input-invalid-'));
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* WorkflowRepository;
        const engine = yield* WorkflowEngine;
        const run = yield* repository.createRun({
          workflowKey: 'agentless-suspend',
          state: { phase: 'start' },
          stateVersion: 1,
          worktreeId: 1,
        });
        yield* repository.completeSuspend({
          runId: run.id,
          state: { phase: 'waiting' },
          waitKind: 'user_input',
          waitCondition: {
            kind: 'user_input',
            questions: [
              {
                kind: 'select',
                key: 'risk',
                label: 'Risk',
                options: [{ value: 'low' }, { value: 'high' }],
              },
            ],
          },
        });
        const submitted = yield* engine
          .submitUserInputDevRun({ runId: run.id, answers: { risk: 'medium' } })
          .pipe(Effect.either);
        const row = yield* repository.findRun(run.id);
        return { submitted, row };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.ok(Either.isLeft(result.submitted));
    assert.ok(result.submitted.left instanceof WorkflowEngineError);
    assert.equal(result.submitted.left.code, 'workflow_user_input_invalid');
    assert.equal(result.row?.status, 'waiting');
    assert.equal(result.row?.waitKind, 'user_input');
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
      observer: fakeHarnessLedgerObserver(),
      agentSessionId: 10,
      text: 'line 1\r\nline 2',
    }),
  );

  assert.deepEqual(writes, [
    { ptyProcessId: 20, data: '\x1b[200~line 1\nline 2\x1b[201~' },
    { ptyProcessId: 20, data: '\r' },
  ]);
});

test('inject fails before writing when a turn is in flight', async () => {
  const writes: Array<{ ptyProcessId: number; data: string }> = [];
  await assert.rejects(
    () =>
      Effect.runPromise(
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
          observer: fakeHarnessLedgerObserver([
            {
              type: 'turn_started',
              agentSessionId: 10,
              harnessSessionId: 'harness-a',
              seq: 1,
              recordedAt: '2026-06-18T00:00:00.000Z',
            },
          ]),
          agentSessionId: 10,
          text: 'blocked',
        }),
      ),
    /turn is already in flight/,
  );

  assert.deepEqual(writes, []);
});

test('inject allows a session whose started turn has a synthesized terminal edge', async () => {
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
      observer: fakeHarnessLedgerObserver([
        {
          type: 'turn_started',
          agentSessionId: 10,
          harnessSessionId: 'harness-a',
          seq: 1,
          recordedAt: '2026-06-18T00:00:00.000Z',
        },
        {
          type: 'turn_failed',
          agentSessionId: 10,
          harnessSessionId: 'harness-a',
          seq: null,
          recordedAt: '2026-06-18T00:00:00.000Z',
          reason: 'new_start_supersedes',
        },
      ]),
      agentSessionId: 10,
      text: 'allowed',
    }),
  );

  assert.equal(writes.length, 2);
});

test('chooseSpawnSplit creates a right column from one pane', () => {
  assert.deepEqual(
    chooseSpawnSplit({ kind: 'leaf', nodeId: 'pane-1', paneId: 1, collapsed: false }),
    { sourcePaneId: 1, direction: 'right' },
  );
});

test('chooseSpawnSplit stacks under the rightmost-bottom pane', () => {
  assert.deepEqual(
    chooseSpawnSplit({
      kind: 'split',
      nodeId: 'split-root',
      axis: 'row',
      sizing: 'manual',
      weights: [0.5, 0.5],
      children: [
        { kind: 'leaf', nodeId: 'pane-1', paneId: 1, collapsed: false },
        {
          kind: 'split',
          nodeId: 'split-right',
          axis: 'column',
          sizing: 'manual',
          weights: [0.5, 0.5],
          children: [
            { kind: 'leaf', nodeId: 'pane-2', paneId: 2, collapsed: false },
            { kind: 'leaf', nodeId: 'pane-3', paneId: 3, collapsed: false },
          ],
        },
      ],
    }),
    { sourcePaneId: 3, direction: 'down' },
  );
});

test('chooseSpawnSplit deterministically appends under a column-start layout', () => {
  assert.deepEqual(
    chooseSpawnSplit({
      kind: 'split',
      nodeId: 'split-root',
      axis: 'column',
      sizing: 'manual',
      weights: [0.5, 0.5],
      children: [
        { kind: 'leaf', nodeId: 'pane-1', paneId: 1, collapsed: false },
        { kind: 'leaf', nodeId: 'pane-2', paneId: 2, collapsed: false },
      ],
    }),
    { sourcePaneId: 2, direction: 'down' },
  );
});

test('workflow ctx spawnSession splits the captured surface and returns paneId', async () => {
  const splitInputs: Parameters<SurfaceServiceShape['splitPane']>[0][] = [];
  const writes: Array<{ ptyProcessId: number; data: string }> = [];
  const ctx = workflowContext({
    repository: fakeWorkflowRepository(),
    run: fakeWorkflowRun({ surfaceId: 1, worktreeId: 1 }),
    agents: {
      ...fakeAgentSessionService(),
      ensureActivePtyProcess: () => Effect.succeed(20),
      activePtyProcessId: () => Effect.succeed(20),
    },
    surfaces: {
      ...fakeSurfaceService(),
      getSurfaceDetail: (surfaceId) =>
        Effect.succeed({
          id: surfaceId,
          worktreeId: 1,
          title: 'Test Surface',
          activePaneId: 7,
          layout: { kind: 'leaf', nodeId: 'pane-7', paneId: 7, collapsed: false },
          panes: [
            {
              id: 8,
              surfaceId,
              title: 'Pi 2',
              sortOrder: 1,
              session: {
                kind: 'agent_session',
                agentSession: {
                  id: 11,
                  paneId: 8,
                  worktreeId: 1,
                  harness: 'pi',
                  cwd: '/tmp/isagi-test-worktree',
                  harnessSessionId: 'harness-b',
                  statusReason: null,
                  recoveryAction: 'resume_existing',
                  status: 'running',
                  diagnosticCode: null,
                  diagnosticDetail: null,
                  createdAt: '2026-06-18T00:00:00.000Z',
                  updatedAt: '2026-06-18T00:00:00.000Z',
                  lastSeenAt: '2026-06-18T00:00:00.000Z',
                },
              },
            },
          ],
        }),
      splitPane: (input) =>
        Effect.sync(() => {
          splitInputs.push(input);
          return {
            worktreeId: input.worktreeId,
            surfaceId: 1,
            paneId: 8,
            title: 'Pi 2',
          };
        }),
      createSurface: () => Effect.die('workflow spawnSession must not create a surface'),
    },
    pty: {
      ...fakePtyService(),
      getAttachmentPlan: () =>
        Effect.succeed({
          session: fakePtyProcessRecord({ id: 20, logPath: null }),
          replayBytes: 1,
          live: true,
          replaySource: 'backend',
        }),
      writeInput: (input) =>
        Effect.sync(() => {
          writes.push(input);
        }),
    },
    artifacts: fakeAgentSessionArtifacts({
      status: 'valid',
      metadata: {
        schemaVersion: 1,
        harnessSessionId: 'harness-b',
        updatedAt: '2026-06-18T00:00:00.000Z',
      },
      metadataPath: '',
    }),
    observer: fakeHarnessLedgerObserver(),
    headless: fakeWorkflowHeadless(),
    worktreePath: '/tmp/isagi-test-worktree',
  });

  const spawned = await ctx.spawnSession({ harness: 'pi', prompt: 'seed' });

  assert.equal(spawned.agentSessionId, 11);
  assert.equal(spawned.harnessSessionId, 'harness-b');
  assert.equal(spawned.paneId, 8);
  assert.deepEqual(splitInputs, [
    {
      worktreeId: 1,
      split: {
        paneId: 7,
        direction: 'right',
        newPane: { kind: 'agent_session', harness: 'pi' },
      },
    },
  ]);
  assert.deepEqual(writes, [
    { ptyProcessId: 20, data: '\x1b[200~seed\x1b[201~' },
    { ptyProcessId: 20, data: '\r' },
  ]);
});

test('workflow ctx spawnSession hard-fails when the run has no captured surface', async () => {
  const ctx = workflowContext({
    repository: fakeWorkflowRepository(),
    run: fakeWorkflowRun({ surfaceId: null, worktreeId: 1 }),
    agents: fakeAgentSessionService(),
    surfaces: fakeSurfaceService(),
    pty: fakePtyService(),
    artifacts: fakeAgentSessionArtifacts(),
    observer: fakeHarnessLedgerObserver(),
    headless: fakeWorkflowHeadless(),
    worktreePath: '/tmp/isagi-test-worktree',
  });

  await assert.rejects(
    () => ctx.spawnSession({ harness: 'pi', prompt: 'seed' }),
    /cannot spawn without a surface_id/,
  );
});

test('workflow ctx closePane delegates to the run surface', async () => {
  const deleted: Array<{ surfaceId: number; paneId: number }> = [];
  const ctx = workflowContext({
    repository: fakeWorkflowRepository(),
    run: fakeWorkflowRun({ surfaceId: 1, worktreeId: 1 }),
    agents: fakeAgentSessionService(),
    surfaces: {
      ...fakeSurfaceService(),
      deleteSurfacePane: (input) =>
        Effect.sync(() => {
          deleted.push(input);
          return { deletedSurfaceId: null, deletedPaneIds: [input.paneId] };
        }),
    },
    pty: fakePtyService(),
    artifacts: fakeAgentSessionArtifacts(),
    observer: fakeHarnessLedgerObserver(),
    headless: fakeWorkflowHeadless(),
    worktreePath: '/tmp/isagi-test-worktree',
  });

  await ctx.closePane(8);

  assert.deepEqual(deleted, [{ surfaceId: 1, paneId: 8 }]);
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

function drainEngineUntilSettled(
  engine: import('./workflow-engine.service.js').WorkflowEngineService,
) {
  return Effect.gen(function* () {
    for (let i = 0; i < 5; i += 1) {
      yield* engine.drainOnce;
      yield* Effect.sleep('10 millis');
    }
  });
}

function testLayer(dataRoot: string) {
  return workflowLayer(dataRoot, Layer.succeed(WorkflowRegistry, createWorkflowRegistry()));
}

function testLayerWithResumeFakes(
  dataRoot: string,
  input: {
    readonly metadataHarnessSessionId: string | null;
    readonly edges: readonly ObservedHarnessTurnEdge[];
  },
) {
  return workflowLayer(dataRoot, Layer.succeed(WorkflowRegistry, createWorkflowRegistry()), {
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
    readonly headless?: WorkflowHeadlessService | undefined;
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
    Layer.provide(Layer.succeed(WorkspaceRepository, fakeWorkspaceRepository())),
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
    Layer.provide(Layer.succeed(WorkflowHeadless, fakes.headless ?? fakeWorkflowHeadless())),
  );
  return Layer.mergeAll(engine, repository, registry, database, stateFile);
}

function databaseLayer(dataRoot: string) {
  const database = RuntimeDatabaseLive.pipe(
    Layer.provide(Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot))),
  );
  const seed = Layer.scopedDiscard(seedDefaultWorkspace).pipe(Layer.provide(database));
  return Layer.mergeAll(database, seed);
}

const seedDefaultWorkspace = Effect.gen(function* () {
  const database = yield* RuntimeDatabase;
  yield* database.use('test_seed_default_workspace', (db) => {
    const now = '2026-06-18T00:00:00.000Z';
    db.insert(projects)
      .values({
        id: 1,
        name: 'Test Project',
        rootPath: '/tmp/isagi-test-project',
        status: 'present',
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
        missingReason: null,
      })
      .onConflictDoNothing()
      .run();
    db.insert(worktrees)
      .values({
        id: 1,
        projectId: 1,
        path: '/tmp/isagi-test-worktree',
        branch: 'main',
        head: 'abc123',
        createdAt: now,
        updatedAt: now,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .onConflictDoNothing()
      .run();
    db.insert(worktreeSurfaces)
      .values({
        id: 1,
        worktreeId: 1,
        title: 'Test Surface',
        layoutJson: JSON.stringify({
          kind: 'leaf',
          nodeId: 'pane-7',
          paneId: 7,
          collapsed: false,
        }),
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
    db.insert(surfacePanes)
      .values({
        id: 7,
        surfaceId: 1,
        title: 'Agent',
        sortOrder: 0,
        sessionKind: 'agent_session',
        sessionId: 10,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
  });
});

function fakeWorkspaceRepository(): WorkspaceRepositoryService {
  return {
    findProject: () => Effect.die('workspace findProject is not used'),
    findProjectByRootPath: () => Effect.die('workspace findProjectByRootPath is not used'),
    findWorktree: (worktreeId) =>
      Effect.succeed({
        id: worktreeId,
        projectId: 1,
        path: '/tmp/isagi-test-worktree',
        branch: 'main',
        head: 'abc123',
        createdAt: '2026-06-18T00:00:00.000Z',
        updatedAt: '2026-06-18T00:00:00.000Z',
        firstSeenAt: '2026-06-18T00:00:00.000Z',
        lastSeenAt: '2026-06-18T00:00:00.000Z',
      }),
    findProjectWorktree: () => Effect.die('workspace findProjectWorktree is not used'),
    findProjectRootWorktree: () => Effect.die('workspace findProjectRootWorktree is not used'),
    findProjectWorktreeByBranch: () =>
      Effect.die('workspace findProjectWorktreeByBranch is not used'),
    deleteProject: () => Effect.die('workspace deleteProject is not used'),
    deleteWorktree: () => Effect.die('workspace deleteWorktree is not used'),
    insertProject: () => Effect.die('workspace insertProject is not used'),
    listProjects: Effect.die('workspace listProjects is not used'),
    listWorktrees: Effect.die('workspace listWorktrees is not used'),
    reconcileProjectWorktrees: () => Effect.die('workspace reconcileProjectWorktrees is not used'),
    restoreProjectAtRootPath: () => Effect.die('workspace restoreProjectAtRootPath is not used'),
    setProjectStatus: () => Effect.die('workspace setProjectStatus is not used'),
  };
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
    getSurfaceDetail: (surfaceId) =>
      Effect.succeed({
        id: surfaceId,
        worktreeId: 1,
        title: 'Test Surface',
        activePaneId: 7,
        layout: { kind: 'leaf', nodeId: 'pane-7', paneId: 7, collapsed: false },
        panes: [
          {
            id: 7,
            surfaceId,
            title: 'Agent',
            sortOrder: 0,
            session: {
              kind: 'agent_session',
              agentSession: {
                id: 10,
                paneId: 7,
                worktreeId: 1,
                harness: 'pi',
                cwd: '/tmp/isagi-test-worktree',
                harnessSessionId: 'harness-a',
                statusReason: null,
                recoveryAction: 'resume_existing',
                status: 'running',
                diagnosticCode: null,
                diagnosticDetail: null,
                createdAt: '2026-06-18T00:00:00.000Z',
                updatedAt: '2026-06-18T00:00:00.000Z',
                lastSeenAt: '2026-06-18T00:00:00.000Z',
              },
            },
          },
        ],
      }),
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
    pin: () => Effect.void,
    unpin: () => Effect.void,
    isPinned: () => Effect.succeed(false),
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

function fakeWorkflowHeadless(
  overrides: Partial<WorkflowHeadlessService> = {},
): WorkflowHeadlessService {
  return {
    runHeadlessPrompt:
      overrides.runHeadlessPrompt ?? (() => Effect.die('headless runHeadlessPrompt is not used')),
    reissue: overrides.reissue ?? (() => Effect.die('headless reissue is not used')),
    completedResults:
      overrides.completedResults ?? (() => Effect.die('headless completedResults is not used')),
    releaseOps: overrides.releaseOps ?? (() => Effect.void),
  };
}

function fakeWorkflowRun(
  overrides: Partial<Pick<WorkflowRunRow, 'surfaceId' | 'worktreeId'>> = {},
): WorkflowRunRow {
  return {
    id: 99,
    workflowKey: 'test-workflow',
    worktreeId: 'worktreeId' in overrides ? (overrides.worktreeId ?? null) : 1,
    surfaceId: 'surfaceId' in overrides ? (overrides.surfaceId ?? null) : 1,
    status: 'running',
    waitKind: null,
    waitCondition: null,
    resumePayload: null,
    stateJson: '{}',
    stateVersion: 1,
    owner: 'test',
    uiFeedback: null,
    error: null,
    resultJson: null,
    createdAt: '2026-06-18T00:00:00.000Z',
    updatedAt: '2026-06-18T00:00:00.000Z',
  };
}

function fakeWorkflowRepository(): WorkflowRepositoryService {
  return {
    createRun: () => Effect.die('workflow createRun is not used'),
    listReadyRuns: Effect.die('workflow listReadyRuns is not used'),
    findRun: () => Effect.die('workflow findRun is not used'),
    pauseNonTerminalRuns: Effect.die('workflow pauseNonTerminalRuns is not used'),
    claimReadyRun: () => Effect.die('workflow claimReadyRun is not used'),
    findWaitingTurnRuns: () => Effect.die('workflow findWaitingTurnRuns is not used'),
    findWaitingWorkflowRuns: () => Effect.die('workflow findWaitingWorkflowRuns is not used'),
    resolveWorkflowJoin: () => Effect.die('workflow resolveWorkflowJoin is not used'),
    wakeWaitingRun: () => Effect.die('workflow wakeWaitingRun is not used'),
    readyPausedRun: () => Effect.die('workflow readyPausedRun is not used'),
    rearmPausedRun: () => Effect.die('workflow rearmPausedRun is not used'),
    completeCont: () => Effect.die('workflow completeCont is not used'),
    completeSuspend: () => Effect.die('workflow completeSuspend is not used'),
    completeDone: () => Effect.die('workflow completeDone is not used'),
    failRun: () => Effect.die('workflow failRun is not used'),
    setUiFeedback: () => Effect.void,
  };
}

function fakePtyProcessRecord(input: {
  readonly id: number;
  readonly logPath: string | null;
}): PtyProcessRecord {
  return {
    id: input.id,
    backend: 'node_pty',
    backendRefJson: '{}',
    command: 'bash',
    argsJson: '[]',
    cwd: '/tmp/isagi-test-worktree',
    status: 'running',
    statusReason: null,
    exitCode: null,
    signal: null,
    logMode: input.logPath ? 'backend_file' : 'none',
    logPath: input.logPath,
    createdAt: '2026-06-18T00:00:00.000Z',
    updatedAt: '2026-06-18T00:00:00.000Z',
    exitedAt: null,
    lastSeenAt: '2026-06-18T00:00:00.000Z',
  };
}
