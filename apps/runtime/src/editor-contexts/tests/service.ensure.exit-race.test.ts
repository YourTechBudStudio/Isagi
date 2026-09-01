import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import { PtyRepository } from '../../pty-processes/pty.repository.js';
import { PtyStartError } from '../../pty-processes/types.js';
import { EditorContextRepository } from '../editor-contexts.repository.js';
import { EditorContextService } from '../editor-contexts.service.js';
import {
  awaitProbeSettled,
  editorBackendStub,
  immediateProbe,
  insertWorktree,
  neverSettlingProbe,
  withEditorService,
} from '../test-support.js';

/**
 * The probe is registered *before* `start`, not after, and this is why: `start`
 * can publish a failure, and a process that dies the instant it spawns can
 * publish an exit, before a post-start registration would ever have run. Whatever
 * terminal event arrives therefore always finds an entry and a fiber to end.
 */
test('a process that fails during start leaves no probe and no observation behind', async () => {
  const result = await withEditorService(
    {
      nodePty: editorBackendStub('node_pty', {
        launch: () =>
          Effect.fail(
            new PtyStartError({
              command: 'code-server',
              cwd: '/repo/isagi',
              cause: new Error('spawn refused'),
            }),
          ),
      }),
      options: { probe: neverSettlingProbe },
    },
    () =>
      Effect.gen(function* () {
        const service = yield* EditorContextService;
        const repository = yield* EditorContextRepository;
        const ptyRepository = yield* PtyRepository;
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const created = yield* repository.create({ worktreeId });

        const facts = yield* service.ensureRuntime({
          editorContextId: created.id,
          intent: 'reuse',
        });
        const ptyProcessId = facts.activePtyProcessId ?? -1;

        // The failure event is published by `start` itself; drain the subscriber.
        const observations = yield* Effect.iterate(
          new Map([[ptyProcessId, true]]) as ReadonlyMap<number, unknown>,
          {
            while: (map) => map.size > 0,
            body: () =>
              Effect.yieldNow().pipe(Effect.zipRight(service.readinessFor([ptyProcessId]))),
          },
        );

        return {
          observations,
          process: yield* ptyRepository.findProcess(ptyProcessId),
          row: yield* repository.find(created.id),
        };
      }),
  );

  assert.equal(result.observations.size, 0);
  assert.equal(result.process?.status, 'failed');
  // Ownership is retained so the failure is reportable and `replace` is the exit.
  assert.notEqual(result.row?.activePtyProcessId, null);
});

test('a dead incarnation cannot project ready even when its observation survives', async () => {
  const result = await withEditorService({ options: { probe: immediateProbe('ready') } }, () =>
    Effect.gen(function* () {
      const service = yield* EditorContextService;
      const repository = yield* EditorContextRepository;
      const ptyRepository = yield* PtyRepository;
      const worktreeId = yield* insertWorktree('/repo/isagi');
      const created = yield* repository.create({ worktreeId });

      const launched = yield* service.ensureRuntime({
        editorContextId: created.id,
        intent: 'reuse',
      });
      const ptyProcessId = launched.activePtyProcessId ?? -1;
      yield* awaitProbeSettled(ptyProcessId);
      // Written directly, so no terminal event is published and the readiness
      // entry deliberately survives. This is the missed-delivery case.
      yield* ptyRepository.transitionProcess({
        ptyProcessId,
        status: 'exited',
        statusReason: null,
        exitCode: 1,
      });

      return {
        retained: (yield* service.readinessFor([ptyProcessId])).size,
        facts: yield* service.ensureRuntime({
          editorContextId: created.id,
          intent: 'reuse',
        }),
      };
    }),
  );

  // The observation is still there...
  assert.equal(result.retained, 1);
  // ...and the projection still refuses to frame it, because safety comes from
  // the row being live rather than from the event having arrived.
  assert.notEqual(result.facts.workbenchReadiness, 'ready');
  assert.equal(result.facts.processStatus, 'exited');
  assert.equal(result.facts.processDiagnostic, 'exited');
});
