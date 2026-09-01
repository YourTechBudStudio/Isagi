import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import { EditorContextRepository } from '../editor-contexts.repository.js';
import { EditorContextService } from '../editor-contexts.service.js';
import {
  awaitProbeSettled,
  editorContextChangedIds,
  immediateProbe,
  insertWorktree,
  neverSettlingProbe,
  withEditorService,
} from '../test-support.js';

test('branch 2: a fresh context launches exactly once and lands an owned incarnation', async () => {
  const result = await withEditorService({ options: { probe: neverSettlingProbe } }, (events) =>
    Effect.gen(function* () {
      const service = yield* EditorContextService;
      const repository = yield* EditorContextRepository;
      const worktreeId = yield* insertWorktree('/repo/isagi');
      const created = yield* repository.create({ worktreeId });

      const facts = yield* service.ensureRuntime({
        editorContextId: created.id,
        intent: 'reuse',
      });
      const row = yield* repository.find(created.id);

      return { facts, row, changed: editorContextChangedIds(events) };
    }),
  );

  assert.notEqual(result.row?.activePtyProcessId, null);
  assert.equal(result.row?.endpointHost, '127.0.0.1');
  assert.notEqual(result.row?.endpointPort, null);
  // The handoff resets the attempt: ownership and an in-flight attempt never coexist.
  assert.deepEqual(result.row?.attempt, { state: 'none' });
  assert.equal(result.facts.workbenchReadiness, 'pending');
  assert.equal(result.facts.endpoint?.host, '127.0.0.1');
  // in_progress, the handoff, and the post-start transition.
  assert.equal(result.changed.length, 3);
});

test('branch 1: a second reuse of a live incarnation starts nothing and changes nothing', async () => {
  const result = await withEditorService(
    { options: { probe: immediateProbe('ready') } },
    (events) =>
      Effect.gen(function* () {
        const service = yield* EditorContextService;
        const repository = yield* EditorContextRepository;
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const created = yield* repository.create({ worktreeId });

        const launched = yield* service.ensureRuntime({
          editorContextId: created.id,
          intent: 'reuse',
        });
        yield* awaitProbeSettled(launched.activePtyProcessId ?? -1);
        const first = yield* repository.find(created.id);
        const eventsAfterLaunch = editorContextChangedIds(events).length;

        const facts = yield* service.ensureRuntime({
          editorContextId: created.id,
          intent: 'reuse',
        });
        const second = yield* repository.find(created.id);

        return {
          firstPtyProcessId: first?.activePtyProcessId,
          secondPtyProcessId: second?.activePtyProcessId,
          updatedAtUnchanged: first?.updatedAt === second?.updatedAt,
          facts,
          newEvents: editorContextChangedIds(events).length - eventsAfterLaunch,
        };
      }),
  );

  assert.equal(result.firstPtyProcessId, result.secondPtyProcessId);
  assert.equal(result.updatedAtUnchanged, true);
  assert.equal(result.newEvents, 0);
  assert.equal(result.facts.workbenchReadiness, 'ready');
});

test('branch 4: a settled unreachable incarnation is reported, never relaunched', async () => {
  const result = await withEditorService(
    {
      options: {
        probe: immediateProbe(
          'unreachable',
          '127.0.0.1:41287 · workbench · marker absent · gave up after 60s',
        ),
      },
    },
    (events) =>
      Effect.gen(function* () {
        const service = yield* EditorContextService;
        const repository = yield* EditorContextRepository;
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const created = yield* repository.create({ worktreeId });

        const launched = yield* service.ensureRuntime({
          editorContextId: created.id,
          intent: 'reuse',
        });
        yield* awaitProbeSettled(launched.activePtyProcessId ?? -1);
        const before = yield* repository.find(created.id);
        const eventsBefore = editorContextChangedIds(events).length;

        const facts = yield* service.ensureRuntime({
          editorContextId: created.id,
          intent: 'reuse',
        });
        const after = yield* repository.find(created.id);

        return {
          samePointer: before?.activePtyProcessId === after?.activePtyProcessId,
          unchanged: before?.updatedAt === after?.updatedAt,
          newEvents: editorContextChangedIds(events).length - eventsBefore,
          facts,
        };
      }),
  );

  assert.equal(result.samePointer, true);
  assert.equal(result.unchanged, true);
  assert.equal(result.newEvents, 0);
  assert.equal(result.facts.workbenchReadiness, 'unreachable');
  assert.equal(
    result.facts.readinessDetail,
    '127.0.0.1:41287 · workbench · marker absent · gave up after 60s',
  );
});

test('branch 4: a failed attempt is reported and never retried by reuse', async () => {
  const result = await withEditorService({ options: { probe: neverSettlingProbe } }, (events) =>
    Effect.gen(function* () {
      const service = yield* EditorContextService;
      const repository = yield* EditorContextRepository;
      const worktreeId = yield* insertWorktree('/repo/isagi');
      const created = yield* repository.create({ worktreeId });
      // A launch whose target is gone leaves a settled failure.
      yield* repository.markAttemptFailed({
        editorContextId: created.id,
        reason: 'launch_target_missing',
        detail: null,
      });
      const before = yield* repository.find(created.id);
      const eventsBefore = editorContextChangedIds(events).length;

      const facts = yield* service.ensureRuntime({
        editorContextId: created.id,
        intent: 'reuse',
      });
      const after = yield* repository.find(created.id);

      return {
        unchanged: before?.updatedAt === after?.updatedAt,
        pointer: after?.activePtyProcessId,
        newEvents: editorContextChangedIds(events).length - eventsBefore,
        facts,
      };
    }),
  );

  assert.equal(result.unchanged, true);
  assert.equal(result.pointer, null);
  assert.equal(result.newEvents, 0);
  assert.deepEqual(result.facts.attempt, {
    state: 'failed',
    reason: 'launch_target_missing',
    detail: null,
  });
  assert.equal(result.facts.processStatus, null);
});

test('branch 4: an in-progress attempt is reported without starting a second launch', async () => {
  const result = await withEditorService({ options: { probe: neverSettlingProbe } }, (events) =>
    Effect.gen(function* () {
      const service = yield* EditorContextService;
      const repository = yield* EditorContextRepository;
      const worktreeId = yield* insertWorktree('/repo/isagi');
      const created = yield* repository.create({ worktreeId });
      yield* repository.markAttemptInProgress(created.id);
      const eventsBefore = editorContextChangedIds(events).length;

      const facts = yield* service.ensureRuntime({
        editorContextId: created.id,
        intent: 'reuse',
      });
      const after = yield* repository.find(created.id);

      return {
        pointer: after?.activePtyProcessId,
        attempt: after?.attempt.state,
        newEvents: editorContextChangedIds(events).length - eventsBefore,
        facts,
      };
    }),
  );

  assert.equal(result.pointer, null);
  assert.equal(result.attempt, 'in_progress');
  assert.equal(result.newEvents, 0);
  assert.equal(result.facts.attempt.state, 'in_progress');
});

test('an unknown editor context is refused before any lock is taken', async () => {
  const failure = await withEditorService({}, (_events) =>
    Effect.gen(function* () {
      const service = yield* EditorContextService;
      return yield* service
        .ensureRuntime({ editorContextId: 999, intent: 'reuse' })
        .pipe(Effect.flip);
    }),
  );

  assert.equal(failure._tag, 'EditorError');
  assert.equal((failure as { code: string }).code, 'editor_context_not_found');
});
