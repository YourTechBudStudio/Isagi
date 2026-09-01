import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import { PtyKillError } from '../../pty-processes/types.js';
import { InternalRuntimeEventBus } from '../../runtime-events/index.js';
import { EditorContextRepository } from '../editor-contexts.repository.js';
import { EditorContextService } from '../editor-contexts.service.js';
import {
  awaitProbeSettled,
  editorBackendStub,
  editorContextChangedIds,
  immediateProbe,
  insertPtyProcess,
  insertWorktree,
  neverSettlingProbe,
  withEditorService,
} from '../test-support.js';

test('every committed attempt transition publishes exactly one normalized change', async () => {
  const changed = await withEditorService({ options: { probe: neverSettlingProbe } }, (events) =>
    Effect.gen(function* () {
      const service = yield* EditorContextService;
      const repository = yield* EditorContextRepository;
      const worktreeId = yield* insertWorktree('/repo/isagi');
      const created = yield* repository.create({ worktreeId });

      // A second client that made none of these requests must still learn of
      // each one; that is the whole reason `none -> in_progress` publishes at
      // all, rather than only the outcome being announced.
      yield* service.ensureRuntime({ editorContextId: created.id, intent: 'reuse' });
      const afterFirst = editorContextChangedIds(events).length;
      yield* service.ensureRuntime({ editorContextId: created.id, intent: 'replace' });
      const afterReplace = editorContextChangedIds(events).length;

      return {
        ids: editorContextChangedIds(events),
        contextId: created.id,
        afterFirst,
        replaceEvents: afterReplace - afterFirst,
      };
    }),
  );

  // in_progress, handoff, post-start.
  assert.equal(changed.afterFirst, 3);
  // clear+in_progress, handoff, post-start.
  assert.equal(changed.replaceEvents, 3);
  assert.ok(changed.ids.every((id) => id === changed.contextId));
});

test('a probe settling publishes, so a client that mounted mid-launch learns of it', async () => {
  const result = await withEditorService(
    { options: { probe: immediateProbe('ready') } },
    (events) =>
      Effect.gen(function* () {
        const service = yield* EditorContextService;
        const repository = yield* EditorContextRepository;
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const created = yield* repository.create({ worktreeId });

        const facts = yield* service.ensureRuntime({
          editorContextId: created.id,
          intent: 'reuse',
        });
        const beforeSettle = editorContextChangedIds(events).length;
        yield* awaitProbeSettled(facts.activePtyProcessId ?? -1);
        return { settleEvents: editorContextChangedIds(events).length - beforeSettle };
      }),
  );

  assert.equal(result.settleEvents, 1);
});

test('a terminal event for an owned incarnation ends its probe and publishes', async () => {
  const result = await withEditorService({ options: { probe: neverSettlingProbe } }, (events) =>
    Effect.gen(function* () {
      const service = yield* EditorContextService;
      const repository = yield* EditorContextRepository;
      const bus = yield* InternalRuntimeEventBus;
      const worktreeId = yield* insertWorktree('/repo/isagi');
      const created = yield* repository.create({ worktreeId });

      const facts = yield* service.ensureRuntime({
        editorContextId: created.id,
        intent: 'reuse',
      });
      const ptyProcessId = facts.activePtyProcessId ?? -1;
      const before = editorContextChangedIds(events).length;

      yield* bus.publish({
        type: 'pty_process_exited',
        ptyProcessId,
        status: 'exited',
        exitCode: 1,
        signal: null,
      });
      // Let the subscriber fiber take the event.
      const observations = yield* Effect.iterate(
        new Map([[ptyProcessId, true]]) as ReadonlyMap<number, unknown>,
        {
          while: (map) => map.size > 0,
          body: () => Effect.yieldNow().pipe(Effect.zipRight(service.readinessFor([ptyProcessId]))),
        },
      );

      return {
        observations,
        newEvents: editorContextChangedIds(events).length - before,
      };
    }),
  );

  // The readiness entry is dropped, so the projection can no longer report the
  // dead incarnation as ready no matter what the probe had observed.
  assert.equal(result.observations.size, 0);
  assert.equal(result.newEvents, 1);
});

test('a terminal event for another domain’s process is ignored entirely', async () => {
  const result = await withEditorService({ options: { probe: neverSettlingProbe } }, (events) =>
    Effect.gen(function* () {
      const service = yield* EditorContextService;
      const repository = yield* EditorContextRepository;
      const bus = yield* InternalRuntimeEventBus;
      const worktreeId = yield* insertWorktree('/repo/isagi');
      const created = yield* repository.create({ worktreeId });

      const facts = yield* service.ensureRuntime({
        editorContextId: created.id,
        intent: 'reuse',
      });
      const before = editorContextChangedIds(events).length;

      const foreign = yield* insertPtyProcess('running');
      yield* bus.publish({
        type: 'pty_process_killed',
        ptyProcessId: foreign,
        status: 'killed',
        statusReason: 'user_requested',
      });
      yield* Effect.yieldNow();
      yield* Effect.yieldNow();

      const observations = yield* service.readinessFor([facts.activePtyProcessId ?? -1]);
      return {
        stillObserved: observations.size,
        newEvents: editorContextChangedIds(events).length - before,
      };
    }),
  );

  assert.equal(result.stillObserved, 1);
  assert.equal(result.newEvents, 0);
});

test('an incarnation whose termination was refused still publishes its terminal event', async () => {
  const result = await withEditorService(
    {
      nodePty: editorBackendStub('node_pty', {
        kill: () => Effect.fail(new PtyKillError({ cause: new Error('no evidence') })),
        terminate: () => Effect.fail(new PtyKillError({ cause: new Error('no evidence') })),
      }),
      options: { probe: neverSettlingProbe },
    },
    (events) =>
      Effect.gen(function* () {
        const service = yield* EditorContextService;
        const repository = yield* EditorContextRepository;
        const bus = yield* InternalRuntimeEventBus;
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const created = yield* repository.create({ worktreeId });

        const first = yield* service.ensureRuntime({
          editorContextId: created.id,
          intent: 'reuse',
        });
        const ptyProcessId = first.activePtyProcessId ?? -1;
        // The replacement is refused, so the row keeps pointing at this process
        // and this runtime is still the one that launched it.
        yield* service
          .ensureRuntime({ editorContextId: created.id, intent: 'replace' })
          .pipe(Effect.flip);
        const before = editorContextChangedIds(events).length;

        yield* bus.publish({
          type: 'pty_process_exited',
          ptyProcessId,
          status: 'exited',
          exitCode: 0,
          signal: null,
        });
        // Let the subscriber fiber take the event, without assuming which turn.
        yield* Effect.iterate(0, {
          while: (turns) => turns < 50 && editorContextChangedIds(events).length === before,
          body: (turns) => Effect.yieldNow().pipe(Effect.as(turns + 1)),
        });

        return { newEvents: editorContextChangedIds(events).length - before };
      }),
  );

  assert.equal(result.newEvents, 1);
});
