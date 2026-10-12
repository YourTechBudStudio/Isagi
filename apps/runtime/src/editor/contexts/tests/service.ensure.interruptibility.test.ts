import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Deferred, Effect, Fiber } from 'effect';

import type { InternalEvent } from '../../../platform/events/index.js';
import { editorServiceLayer, insertWorktree, withEditorService } from '../../testing.js';
import { EditorContextRepository } from '../repository.js';
import { EditorContextService } from '../service.js';

/**
 * The forked probe must be genuinely interruptible. It is forked inside an
 * uninterruptible mask, so it only stays interruptible because the fork happens
 * through `restore` — and a fiber that inherited the uninterruptible flag would
 * ignore supersession, terminal events, and shutdown alike, silently.
 */
test('layer shutdown interrupts a probe that would otherwise never settle', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-editor-shutdown-'));
  const events: InternalEvent[] = [];
  const probeStarted = Deferred.makeUnsafe<void>();
  let probeInterrupted = false;
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* EditorContextService;
        const repository = yield* EditorContextRepository;
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const created = yield* repository.create({ worktreeId });
        yield* service.ensureRuntime({ editorContextId: created.id, intent: 'reuse' });
        // The probe is forked, so it starts on a later scheduler turn. Shut down
        // only once it is running: a fiber interrupted before it starts never
        // reaches `onInterrupt`, which would fail this test for the wrong reason.
        yield* Deferred.await(probeStarted);
      }).pipe(
        Effect.provide(
          editorServiceLayer({
            dataRoot,
            events,
            options: {
              probe: () =>
                Deferred.succeed(probeStarted, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() =>
                    Effect.sync(() => {
                      probeInterrupted = true;
                    }),
                  ),
                ),
            },
          }),
        ),
        Effect.scoped,
      ),
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }

  // If this were false the runtime would leak a fiber per incarnation for its
  // whole life, and this test would hang rather than fail.
  assert.equal(probeInterrupted, true);
});

test('an ensure cancelled while a probe is registered does not wait on the spawn', async () => {
  const result = await withEditorService(
    {
      options: {
        probe: () => Effect.never,
      },
    },
    () =>
      Effect.gen(function* () {
        const service = yield* EditorContextService;
        const repository = yield* EditorContextRepository;
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const created = yield* repository.create({ worktreeId });

        const fiber = yield* Effect.forkChild(
          service.ensureRuntime({ editorContextId: created.id, intent: 'reuse' }),
        );
        yield* Effect.yieldNow;
        // The cancellation completes rather than blocking behind the spawn,
        // which is what `restore(allocation.start)` buys.
        yield* Fiber.interrupt(fiber);
        return yield* repository.find(created.id);
      }),
  );

  assert.notEqual(result, null);
  assert.ok(
    result?.activePtyProcessId !== null || result?.attempt.state === 'failed',
    `cancelled ensure left an unsettled row: ${JSON.stringify(result)}`,
  );
});
