import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Context, Effect, Exit, Layer, Scope } from 'effect';

import { EntityLock } from '../../../platform/locks/index.js';
import { PtyKillError } from '../../../pty-processes/index.js';
import { PtyRepository } from '../../../pty-processes/testing.js';
import {
  editorBackendStub,
  editorServiceLayer,
  immediateProbe,
  insertWorktree,
  neverSettlingProbe,
  withEditorService,
} from '../../testing.js';
import { EditorContextRepository } from '../repository.js';
import { EditorContextService, editorLockKey } from '../service.js';

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
        target: yield* service.proxyTarget(created.id),
      };
    }),
  );

  assert.equal(result.target, null);
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

test('closing the layer leaves the proxy no target', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-editor-close-'));
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const context = yield* Layer.buildWithScope(
          editorServiceLayer({ dataRoot, events: [], options: { probe: neverSettlingProbe } }),
          scope,
        );
        const service = Context.get(context, EditorContextService);
        const created = yield* Effect.gen(function* () {
          const worktreeId = yield* insertWorktree('/repo/isagi');
          const repository = yield* EditorContextRepository;
          return yield* repository.create({ worktreeId });
        }).pipe(Effect.provideContext(context));
        yield* service.ensureRuntime({ editorContextId: created.id, intent: 'reuse' });
        const before = yield* service.proxyTarget(created.id);
        yield* Scope.close(scope, Exit.void);
        return { before, after: yield* service.proxyTarget(created.id) };
      }),
    );
    assert.notEqual(result.before, null);
    assert.equal(result.after, null);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
