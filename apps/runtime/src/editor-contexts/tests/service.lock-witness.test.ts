import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Exit } from 'effect';

import { EntityLock } from '../../lib/locks/entity-lock.js';
import { EditorContextRepository } from '../editor-contexts.repository.js';
import { EditorContextService, editorLockKey } from '../editor-contexts.service.js';
import { insertWorktree, neverSettlingProbe, withEditorService } from '../test-support.js';

/**
 * `EntityLockHeld` proves that *a* lock was held, not which one. Since the key
 * union spans three kinds, a witness from an agent session — or from the right
 * kind but the wrong worktree — is structurally acceptable without these checks,
 * and the one-context-per-worktree serialization would be silently gone.
 */
test('creation under the correct witness succeeds', async () => {
  const row = await withEditorService({ options: { probe: neverSettlingProbe } }, () =>
    Effect.gen(function* () {
      const service = yield* EditorContextService;
      const lock = yield* EntityLock;
      const worktreeId = yield* insertWorktree('/repo/isagi');
      return yield* lock.withLock(editorLockKey(worktreeId), (held) =>
        service.createForWorktree({ held, worktreeId }),
      );
    }),
  );

  assert.equal(row.activePtyProcessId, null);
  assert.deepEqual(row.attempt, { state: 'none' });
});

test('creation under a witness for another lock kind is a defect', async () => {
  const exit = await withEditorService({ options: { probe: neverSettlingProbe } }, () =>
    Effect.gen(function* () {
      const service = yield* EditorContextService;
      const lock = yield* EntityLock;
      const worktreeId = yield* insertWorktree('/repo/isagi');
      return yield* lock
        .withLock({ kind: 'agent_session', id: worktreeId }, (held) =>
          service.createForWorktree({ held, worktreeId }),
        )
        .pipe(Effect.exit);
    }),
  );

  assert.ok(Exit.isFailure(exit));
});

test('creation under a witness for another worktree is a defect', async () => {
  const exit = await withEditorService({ options: { probe: neverSettlingProbe } }, () =>
    Effect.gen(function* () {
      const service = yield* EditorContextService;
      const lock = yield* EntityLock;
      const worktreeId = yield* insertWorktree('/repo/isagi');
      return yield* lock
        .withLock(editorLockKey(worktreeId + 1), (held) =>
          service.createForWorktree({ held, worktreeId }),
        )
        .pipe(Effect.exit);
    }),
  );

  assert.ok(Exit.isFailure(exit));
});

test('releasing under a witness for another worktree is a defect', async () => {
  const exit = await withEditorService({ options: { probe: neverSettlingProbe } }, () =>
    Effect.gen(function* () {
      const service = yield* EditorContextService;
      const repository = yield* EditorContextRepository;
      const lock = yield* EntityLock;
      const worktreeId = yield* insertWorktree('/repo/isagi');
      const created = yield* repository.create({ worktreeId });
      return yield* lock
        .withLock(editorLockKey(worktreeId + 1), (held) =>
          service.releaseIncarnation({ held, editorContextId: created.id }),
        )
        .pipe(Effect.exit);
    }),
  );

  assert.ok(Exit.isFailure(exit));
});
