import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import { EntityLock } from '../../lib/locks/entity-lock.js';
import { PtyRepository } from '../../pty-processes/pty.repository.js';
import { PtyKillError } from '../../pty-processes/types.js';
import { EditorContextRepository } from '../editor-contexts.repository.js';
import { EditorContextService, editorLockKey } from '../editor-contexts.service.js';
import {
  editorBackendStub,
  immediateProbe,
  insertWorktree,
  neverSettlingProbe,
  withEditorService,
} from '../test-support.js';

test('an affirmative stop clears the pointer, endpoint, and attempt', async () => {
  const result = await withEditorService({ options: { probe: immediateProbe('ready') } }, () =>
    Effect.gen(function* () {
      const service = yield* EditorContextService;
      const repository = yield* EditorContextRepository;
      const lock = yield* EntityLock;
      const worktreeId = yield* insertWorktree('/repo/isagi');
      const created = yield* repository.create({ worktreeId });
      const facts = yield* service.ensureRuntime({
        editorContextId: created.id,
        intent: 'reuse',
      });

      yield* lock.withLock(editorLockKey(worktreeId), (held) =>
        service.releaseIncarnation({ held, editorContextId: created.id }),
      );

      return {
        row: yield* repository.find(created.id),
        observations: yield* service.readinessFor([facts.activePtyProcessId ?? -1]),
      };
    }),
  );

  assert.equal(result.row?.activePtyProcessId, null);
  assert.equal(result.row?.endpointHost, null);
  assert.equal(result.row?.endpointPort, null);
  assert.equal(result.row?.sessionSocketPath, null);
  assert.deepEqual(result.row?.attempt, { state: 'none' });
  assert.equal(result.observations.size, 0);
});

test('release never fails on a termination problem and retains ownership instead', async () => {
  const result = await withEditorService(
    {
      nodePty: editorBackendStub('node_pty', {
        terminate: () => Effect.fail(new PtyKillError({ cause: new Error('no evidence') })),
        kill: () => Effect.fail(new PtyKillError({ cause: new Error('no evidence') })),
      }),
      options: { probe: neverSettlingProbe },
    },
    () =>
      Effect.gen(function* () {
        const service = yield* EditorContextService;
        const repository = yield* EditorContextRepository;
        const lock = yield* EntityLock;
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const created = yield* repository.create({ worktreeId });
        const facts = yield* service.ensureRuntime({
          editorContextId: created.id,
          intent: 'reuse',
        });

        // Deleting a surface must not fail because a process would not answer;
        // the diagnostic goes on the row and the caller carries on.
        yield* lock.withLock(editorLockKey(worktreeId), (held) =>
          service.releaseIncarnation({ held, editorContextId: created.id }),
        );

        return { facts, row: yield* repository.find(created.id) };
      }),
  );

  assert.equal(result.row?.activePtyProcessId, result.facts.activePtyProcessId);
  const attempt = result.row?.attempt;
  assert.ok(attempt !== undefined && attempt.state === 'failed');
  assert.equal(attempt.reason, 'previous_incarnation_not_stopped');
});

test('releasing an idle context and a vanished one are both no-ops', async () => {
  const result = await withEditorService({ options: { probe: neverSettlingProbe } }, () =>
    Effect.gen(function* () {
      const service = yield* EditorContextService;
      const repository = yield* EditorContextRepository;
      const lock = yield* EntityLock;
      const worktreeId = yield* insertWorktree('/repo/isagi');
      const created = yield* repository.create({ worktreeId });

      yield* lock.withLock(editorLockKey(worktreeId), (held) =>
        service.releaseIncarnation({ held, editorContextId: created.id }),
      );
      // A context that is already gone: cleanup has converged on its goal, so
      // there is nothing left to fail about.
      yield* lock.withLock(editorLockKey(worktreeId), (held) =>
        service.releaseIncarnation({ held, editorContextId: 4_242 }),
      );

      return yield* repository.find(created.id);
    }),
  );

  assert.deepEqual(result?.attempt, { state: 'none' });
  assert.equal(result?.activePtyProcessId, null);
});

test('release stops the process it owned', async () => {
  const result = await withEditorService({ options: { probe: neverSettlingProbe } }, () =>
    Effect.gen(function* () {
      const service = yield* EditorContextService;
      const repository = yield* EditorContextRepository;
      const ptyRepository = yield* PtyRepository;
      const lock = yield* EntityLock;
      const worktreeId = yield* insertWorktree('/repo/isagi');
      const created = yield* repository.create({ worktreeId });
      const facts = yield* service.ensureRuntime({
        editorContextId: created.id,
        intent: 'reuse',
      });

      yield* lock.withLock(editorLockKey(worktreeId), (held) =>
        service.releaseIncarnation({ held, editorContextId: created.id }),
      );

      return yield* ptyRepository.findProcess(facts.activePtyProcessId ?? -1);
    }),
  );

  assert.equal(result?.status, 'killed');
});
