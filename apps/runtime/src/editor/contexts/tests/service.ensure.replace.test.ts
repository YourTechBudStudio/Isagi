import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import { PtyKillError, PtyServiceError } from '../../../pty-processes/index.js';
import {
  awaitProbeSettled,
  editorBackendStub,
  editorContextChangedIds,
  immediateProbe,
  insertWorktree,
  neverSettlingProbe,
  withEditorService,
} from '../../testing.js';
import { EditorContextRepository } from '../repository.js';
import { EditorContextService } from '../service.js';

test('replace stops the previous incarnation and launches a new one', async () => {
  const result = await withEditorService({ options: { probe: neverSettlingProbe } }, (events) =>
    Effect.gen(function* () {
      const service = yield* EditorContextService;
      const repository = yield* EditorContextRepository;
      const worktreeId = yield* insertWorktree('/repo/isagi');
      const created = yield* repository.create({ worktreeId });

      const first = yield* service.ensureRuntime({
        editorContextId: created.id,
        intent: 'reuse',
      });
      const firstRow = yield* repository.find(created.id);
      const eventsBefore = editorContextChangedIds(events).length;
      const second = yield* service.ensureRuntime({
        editorContextId: created.id,
        intent: 'replace',
      });
      const row = yield* repository.find(created.id);

      return {
        firstPort: firstRow?.endpointPort,
        target: yield* service.proxyTarget(created.id),
        firstPtyProcessId: first.activePtyProcessId,
        secondPtyProcessId: second.activePtyProcessId,
        row,
        newEvents: editorContextChangedIds(events).length - eventsBefore,
      };
    }),
  );

  assert.notEqual(result.firstPtyProcessId, result.secondPtyProcessId);
  assert.equal(result.row?.activePtyProcessId, result.secondPtyProcessId);
  // The proxy forwards to the replacement only; the old incarnation is never a target again.
  assert.deepEqual(result.target, { host: '127.0.0.1', port: result.row?.endpointPort });
  assert.notEqual(result.target?.port, result.firstPort);
  assert.deepEqual(result.row?.attempt, { state: 'none' });
  // clear+in_progress, the handoff, and the post-start transition.
  assert.equal(result.newEvents, 3);
});

test('a termination failure launches nothing and retains the previous ownership', async () => {
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
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const created = yield* repository.create({ worktreeId });

        const first = yield* service.ensureRuntime({
          editorContextId: created.id,
          intent: 'reuse',
        });
        const firstRow = yield* repository.find(created.id);
        const failure = yield* service
          .ensureRuntime({ editorContextId: created.id, intent: 'replace' })
          .pipe(Effect.flip);
        const row = yield* repository.find(created.id);
        const processes = yield* repository
          .findByActivePtyProcessId(first.activePtyProcessId ?? -1)
          .pipe(Effect.map((found) => found?.id ?? null));

        return {
          first,
          firstPort: firstRow?.endpointPort,
          failure,
          row,
          target: yield* service.proxyTarget(created.id),
          ownedBy: processes,
          events,
        };
      }),
  );

  assert.equal(result.failure._tag, 'EditorLaunchFailed');
  assert.equal((result.failure as { reason: string }).reason, 'previous_incarnation_not_stopped');
  // Nothing was cleared: a second incarnation beside a process that may still be
  // alive is the one outcome this path must never produce.
  assert.equal(result.row?.activePtyProcessId, result.first.activePtyProcessId);
  assert.equal(result.row?.endpointPort, result.firstPort);
  // The surviving incarnation is still the proxy's target.
  assert.deepEqual(result.target, { host: '127.0.0.1', port: result.firstPort });
  assert.equal(result.ownedBy, result.row?.id);
  const attempt = result.row?.attempt;
  assert.ok(attempt !== undefined && attempt.state === 'failed');
  assert.equal(attempt.reason, 'previous_incarnation_not_stopped');
});

test('an already absent incarnation counts as affirmative and the replacement proceeds', async () => {
  const result = await withEditorService(
    {
      nodePty: editorBackendStub('node_pty', {
        terminate: () =>
          Effect.fail(new PtyServiceError({ code: 'session_not_found', message: 'gone' }) as never),
      }),
      options: { probe: neverSettlingProbe },
    },
    () =>
      Effect.gen(function* () {
        const service = yield* EditorContextService;
        const repository = yield* EditorContextRepository;
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const created = yield* repository.create({ worktreeId });

        const first = yield* service.ensureRuntime({
          editorContextId: created.id,
          intent: 'reuse',
        });
        // The PTY row is deleted underneath, so termination reports the process
        // is simply not there — an observed absence, not a failure to stop it.
        const second = yield* service.ensureRuntime({
          editorContextId: created.id,
          intent: 'replace',
        });
        return { first, second };
      }),
  );

  assert.notEqual(result.second.activePtyProcessId, result.first.activePtyProcessId);
  assert.equal(result.second.attempt.state, 'none');
});

test('replace from an idle context is a first launch, not a replacement', async () => {
  const result = await withEditorService({ options: { probe: neverSettlingProbe } }, () =>
    Effect.gen(function* () {
      const service = yield* EditorContextService;
      const repository = yield* EditorContextRepository;
      const worktreeId = yield* insertWorktree('/repo/isagi');
      const created = yield* repository.create({ worktreeId });

      const facts = yield* service.ensureRuntime({
        editorContextId: created.id,
        intent: 'replace',
      });
      return facts;
    }),
  );

  assert.notEqual(result.activePtyProcessId, null);
  assert.equal(result.workbenchReadiness, 'pending');
});

test('replace supersedes the previous probe rather than leaving it running', async () => {
  const result = await withEditorService({ options: { probe: immediateProbe('ready') } }, () =>
    Effect.gen(function* () {
      const service = yield* EditorContextService;
      const repository = yield* EditorContextRepository;
      const worktreeId = yield* insertWorktree('/repo/isagi');
      const created = yield* repository.create({ worktreeId });

      const first = yield* service.ensureRuntime({
        editorContextId: created.id,
        intent: 'reuse',
      });
      yield* awaitProbeSettled(first.activePtyProcessId ?? -1);
      const second = yield* service.ensureRuntime({
        editorContextId: created.id,
        intent: 'replace',
      });

      // The superseded incarnation's observation is gone; only the current one
      // is tracked.
      const observations = yield* service.readinessFor([
        first.activePtyProcessId ?? -1,
        second.activePtyProcessId ?? -1,
      ]);
      return {
        previous: observations.get(first.activePtyProcessId ?? -1),
        current: observations.get(second.activePtyProcessId ?? -1),
      };
    }),
  );

  assert.equal(result.previous, undefined);
  assert.notEqual(result.current, undefined);
});
