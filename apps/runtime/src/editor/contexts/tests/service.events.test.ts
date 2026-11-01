import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import { InternalEvents } from '../../../platform/events/index.js';
import { PtyKillError } from '../../../pty-processes/index.js';
import {
  awaitProbeSettled,
  editorBackendStub,
  editorContextChangedIds,
  immediateProbe,
  insertPtyProcess,
  insertWorktree,
  neverSettlingProbe,
  withEditorService,
} from '../../testing.js';
import { EditorContextRepository } from '../repository.js';
import { EditorContextService } from '../service.js';

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
      const bus = yield* InternalEvents;
      const worktreeId = yield* insertWorktree('/repo/isagi');
      const created = yield* repository.create({ worktreeId });

      const facts = yield* service.ensureRuntime({
        editorContextId: created.id,
        intent: 'reuse',
      });
      const ptyProcessId = facts.activePtyProcessId ?? -1;
      const before = editorContextChangedIds(events).length;
      const targetBefore = yield* service.proxyTarget(created.id);

      yield* bus.publish({
        type: 'pty_process_exited',
        ptyProcessId,
        status: 'exited',
        exitCode: 1,
        signal: null,
      });
      // Let the subscriber fiber take the event.
      let observations: ReadonlyMap<number, unknown> = new Map([[ptyProcessId, true]]);
      while (observations.size > 0) {
        yield* Effect.yieldNow;
        observations = yield* service.readinessFor([ptyProcessId]);
      }

      return {
        observations,
        targetBefore,
        targetAfter: yield* service.proxyTarget(created.id),
        newEvents: editorContextChangedIds(events).length - before,
      };
    }),
  );

  // The readiness entry is dropped, so the projection can no longer report the
  // dead incarnation as ready no matter what the probe had observed.
  assert.equal(result.observations.size, 0);
  // And the proxy stops forwarding to it, though the row still names its endpoint.
  assert.notEqual(result.targetBefore, null);
  assert.equal(result.targetAfter, null);
  assert.equal(result.newEvents, 1);
});

test('a terminal event for another domain’s process is ignored entirely', async () => {
  const result = await withEditorService({ options: { probe: neverSettlingProbe } }, (events) =>
    Effect.gen(function* () {
      const service = yield* EditorContextService;
      const repository = yield* EditorContextRepository;
      const bus = yield* InternalEvents;
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
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

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
        const bus = yield* InternalEvents;
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
        for (
          let turns = 0;
          turns < 50 && editorContextChangedIds(events).length === before;
          turns += 1
        ) {
          yield* Effect.yieldNow;
        }

        return { newEvents: editorContextChangedIds(events).length - before };
      }),
  );

  assert.equal(result.newEvents, 1);
});
