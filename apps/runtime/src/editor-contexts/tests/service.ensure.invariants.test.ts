import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Fiber } from 'effect';

import { PtyRepository } from '../../pty-processes/pty.repository.js';
import { isTerminalPtyProcessStatus, PtyStartError } from '../../pty-processes/types.js';
import { EditorContextRepository } from '../editor-contexts.repository.js';
import { EditorContextService } from '../editor-contexts.service.js';
import {
  editorBackendStub,
  insertWorktree,
  neverSettlingProbe,
  withEditorService,
} from './test-support.js';

test('a launch that fails during start keeps its ownership and reports through the process', async () => {
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
        const row = yield* repository.find(created.id);
        const process = yield* ptyRepository.findProcess(row?.activePtyProcessId ?? -1);
        return { facts, row, process };
      }),
  );

  // The handoff committed before the spawn was attempted, so the failure lands
  // on a process this context already owned rather than on an orphan.
  assert.notEqual(result.row?.activePtyProcessId, null);
  assert.deepEqual(result.row?.attempt, { state: 'none' });
  assert.equal(result.process?.status, 'failed');
  assert.equal(result.process?.statusReason, 'backend_launch_failed');
  // Class A: folded into the process facts, never raised as an error.
  assert.equal(result.facts.processDiagnostic, 'launch_failed');
  assert.equal(result.facts.workbenchReadiness, null);
});

test('an interruption during preparation lands launch_interrupted, not a stuck attempt', async () => {
  const result = await withEditorService(
    {
      portProbe: {
        probeInactive: () => Effect.succeed(true),
        // Never answers, so the request is cancelled while still preparing.
        obtainEphemeralPort: Effect.never,
      },
      options: { probe: neverSettlingProbe },
    },
    () =>
      Effect.gen(function* () {
        const service = yield* EditorContextService;
        const repository = yield* EditorContextRepository;
        const ptyRepository = yield* PtyRepository;
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const created = yield* repository.create({ worktreeId });

        const fiber = yield* Effect.fork(
          service.ensureRuntime({ editorContextId: created.id, intent: 'reuse' }),
        );
        yield* Effect.yieldNow();
        yield* Fiber.interrupt(fiber);

        return {
          row: yield* repository.find(created.id),
          processes: yield* ptyRepository.listProcesses(),
        };
      }),
  );

  assert.deepEqual(result.row?.attempt, {
    state: 'failed',
    reason: 'launch_interrupted',
    detail: null,
  });
  assert.equal(result.row?.activePtyProcessId, null);
  // Nothing was allocated, so no row was left behind to reap.
  assert.deepEqual(result.processes, []);
});

test('an interruption after the handoff abandons the allocation rather than reserving it forever', async () => {
  const result = await withEditorService(
    {
      nodePty: editorBackendStub('node_pty', {
        // Blocks inside `start`, which is the one restored point after ownership
        // has already committed. This is the window a blanket uninterruptible
        // region used to hide: the row was reserved and nothing would ever
        // start or abandon it.
        launch: () => Effect.never,
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

        const fiber = yield* Effect.fork(
          service.ensureRuntime({ editorContextId: created.id, intent: 'reuse' }),
        );
        // Wait for the handoff to commit, which is precisely the interruption
        // window under test rather than an arbitrary delay.
        const owned = yield* Effect.iterate(null as number | null, {
          while: (ptyProcessId) => ptyProcessId === null,
          body: () =>
            Effect.yieldNow().pipe(
              Effect.zipRight(repository.find(created.id)),
              Effect.map((row) => row?.activePtyProcessId ?? null),
            ),
        });
        yield* Fiber.interrupt(fiber);

        return {
          row: yield* repository.find(created.id),
          process: yield* ptyRepository.findProcess(owned ?? -1),
        };
      }),
  );

  // Ownership survives and the allocation reached a terminal state rather than
  // staying reserved forever, which is the property at stake. *Which* terminal
  // status a cancelled spawn produces belongs to the PTY layer's own
  // cancellation cleanup, so this asserts the settled fact rather than pinning a
  // neighbouring domain's choice.
  assert.notEqual(result.row?.activePtyProcessId, null);
  assert.deepEqual(result.row?.attempt, { state: 'none' });
  assert.ok(
    result.process !== null && isTerminalPtyProcessStatus(result.process.status),
    `expected a terminal process, got ${JSON.stringify(result.process)}`,
  );
  // The pane therefore reads a dead incarnation and `replace` is the exit.
  assert.notEqual(result.process?.status, 'starting');
});

test('no failure path ever leaves an in-progress attempt beside a pointer', async () => {
  const rows = await withEditorService(
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
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const created = yield* repository.create({ worktreeId });

        const snapshots = [];
        yield* service.ensureRuntime({ editorContextId: created.id, intent: 'reuse' });
        snapshots.push(yield* repository.find(created.id));
        yield* service.ensureRuntime({ editorContextId: created.id, intent: 'replace' });
        snapshots.push(yield* repository.find(created.id));
        yield* service.ensureRuntime({ editorContextId: created.id, intent: 'replace' });
        snapshots.push(yield* repository.find(created.id));
        return snapshots;
      }),
  );

  for (const row of rows) {
    assert.ok(
      row !== null && !(row.attempt.state === 'in_progress' && row.activePtyProcessId !== null),
      `in_progress beside a pointer: ${JSON.stringify(row)}`,
    );
  }
});
