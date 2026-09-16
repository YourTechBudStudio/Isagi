import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Layer } from 'effect';

import { DatabaseError, DataDirectory, RuntimeDatabaseLive } from '../../persistence/index.js';
import { makeTestDataDirectory } from '../../persistence/test-support.js';
import {
  PtyRepository,
  PtyRepositoryLive,
  type PtyRepositoryService,
} from '../../pty-processes/pty.repository.js';
import { reconcilePersistedProcesses } from '../../pty-processes/pty.service.js';
import { allocateLaunch, type PtyLaunchDependencies } from '../../pty-processes/service/launch.js';
import type { PtyReservations } from '../../pty-processes/service/lifecycle.js';
import { fakeBackendCatalog, manualPtyRetryScheduler } from '../../pty-processes/test-support.js';
import {
  PtyStartError,
  type BackendSessionRef,
  type PtyBackend as PtyBackendShape,
  type PtyBackendName,
} from '../../pty-processes/types.js';
import { publishOnlyRecordingEventBus } from '../../runtime-events/test-support.js';
import type { WorkflowOperationRecord } from '../persistence/records.js';
import { classifyHeadlessEvidence } from './classify.js';
import type { HeadlessReceipt } from './receipts.js';

/**
 * The launch seam, driven through the **real** `allocateLaunch` and the real `PtyRepository`.
 *
 * The fake adapters elsewhere in this module are deliberately convenient; they cannot prove what
 * `createProcessMetadata` and `prepareLaunch` actually write, and those writes are exactly what an
 * earlier draft of this design reasoned from and got backwards. These tests carry the rows a real
 * launch produces into the real classifier.
 */

function backendStub(name: PtyBackendName, overrides: Partial<PtyBackendShape> = {}) {
  return {
    name,
    available: Effect.succeed(true),
    launch: () =>
      Effect.succeed({
        schemaVersion: 1,
        backend: 'node_pty',
        ptyProcessId: 1,
        pid: 4242,
      } satisfies BackendSessionRef),
    writeInput: () => Effect.void,
    attach: () => Effect.die(`${name} attach is not expected here`),
    replay: () => Effect.void,
    inspect: () => Effect.succeed({ status: 'alive' as const }),
    listSessions: Effect.succeed([]),
    kill: () => Effect.succeed({ terminated: true }),
    ...overrides,
  } satisfies PtyBackendShape;
}

interface Harness {
  readonly repository: PtyRepositoryService;
  readonly dependencies: (
    backend: PtyBackendShape,
    repository?: PtyRepositoryService,
  ) => PtyLaunchDependencies;
}

function withHarness<A, E>(body: (harness: Harness) => Effect.Effect<A, E, never>) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-workflow-real-pty-'));
  const paths = makeTestDataDirectory(dataRoot);
  mkdirSync(paths.paths.sessionsPath, { recursive: true });
  const directory = Layer.succeed(DataDirectory, paths);
  const database = RuntimeDatabaseLive.pipe(Layer.provide(directory));
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const repository = yield* PtyRepository;
        const bus = publishOnlyRecordingEventBus('these tests do not subscribe');
        const reservations: PtyReservations = { terminations: new Map(), launches: new Map() };
        return yield* body({
          repository,
          dependencies: (backend, override) => ({
            repository: override ?? repository,
            catalog: fakeBackendCatalog({
              configured: 'node_pty',
              nodePty: backend,
              tmux: backendStub('tmux', {
                launch: () => Effect.die('tmux is not the configured launch backend here'),
              }),
            }),
            eventBus: bus.service,
            foreground: {
              set: () => Effect.succeed(false),
              clear: () => Effect.succeed(false),
              isWorking: () => false,
            },
            retry: manualPtyRetryScheduler(),
            reservations,
            activeAttachments: new Map(),
            runtimeNamespace: 'testns',
            sessionsPath: paths.paths.sessionsPath,
            userProcessEnvironment: {},
          }),
        });
      }).pipe(Effect.provide(PtyRepositoryLive.pipe(Layer.provide(database)))),
    ),
  ).finally(() => {
    rmSync(dataRoot, { recursive: true, force: true });
  });
}

const INCARNATION = 'incarnation-a';

function operation(
  input: Partial<WorkflowOperationRecord> & { readonly ptyProcessId: number | null },
): WorkflowOperationRecord {
  return {
    id: 1,
    operationKey: 'wop_1',
    runId: 1,
    frameId: 1,
    executionId: 1,
    originAttemptId: 1,
    capability: 'run_headless_agent',
    callIndex: 0,
    requestFingerprint: 'fp',
    request: null,
    artifactHash: 'pin',
    state: 'dispatched',
    stage: null,
    receipt: null,
    result: null,
    targetKind: 'pty_process',
    targetId: input.ptyProcessId,
    captureOwner: INCARNATION,
    attribution: 'not_applicable',
    correlatedStartSeq: null,
    correlatedHarnessSessionId: null,
    submissionWatermark: null,
    stopState: 'not_requested',
    stopDetail: null,
    stopRequestedAt: null,
    stopSettledAt: null,
    uncertaintyDetail: null,
    lateEvidence: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    dispatchedAt: null,
    settledAt: null,
    ...input,
  } as WorkflowOperationRecord;
}

function receiptFor(
  ptyProcessId: number,
  overrides: Partial<HeadlessReceipt> = {},
): HeadlessReceipt {
  return {
    ptyProcessId,
    harness: 'claude',
    effectiveTimeoutMs: 600_000,
    launchedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('each real launch outcome maps to the settlement its evidence supports', async () => {
  await withHarness((harness) =>
    Effect.gen(function* () {
      const spawned = yield* allocateLaunch(harness.dependencies(backendStub('node_pty')), {
        command: 'pnpm',
        args: ['judge'],
        cwd: '/repo/isagi',
      });
      const spawnedMetadata = yield* spawned.start;
      assert.equal(spawnedMetadata.launchOutcome, 'spawned');
      assert.equal(
        classifyHeadlessEvidence({
          record: operation({ ptyProcessId: spawned.ptyProcessId, stage: 'started' }),
          receipt: receiptFor(spawned.ptyProcessId, { launchOutcome: 'spawned' }),
          incarnationId: INCARNATION,
        }).kind,
        'owned',
      );

      // A preparation failure, produced the way the owner really produces one.
      const failingRepository: PtyRepositoryService = {
        ...harness.repository,
        updateBackendMetadata: () =>
          Effect.fail(
            new DatabaseError({
              operation: 'update_pty_backend_metadata',
              cause: new Error('disk full'),
            }),
          ),
      };
      const prepared = yield* allocateLaunch(
        harness.dependencies(
          backendStub('node_pty', {
            launch: () => Effect.die('the backend must not be reached after a preparation fault'),
          }),
          failingRepository,
        ),
        { command: 'pnpm', args: ['judge'], cwd: '/repo/isagi' },
      );
      const preparedMetadata = yield* prepared.start;
      assert.equal(preparedMetadata.launchOutcome, 'preparation_failed');
      const preparationEvidence = classifyHeadlessEvidence({
        record: operation({ ptyProcessId: prepared.ptyProcessId, stage: 'launch_failed' }),
        receipt: receiptFor(prepared.ptyProcessId, {
          launchOutcome: preparedMetadata.launchOutcome,
          launchFailureCause: preparedMetadata.launchFailureCause,
        }),
        incarnationId: INCARNATION,
      });
      assert.equal(preparationEvidence.kind, 'abandon');
      // The case the design is emphatic about: a preparation failure must never be reported after a
      // restart as the interruption of an agent that never ran.
      assert.notEqual(preparationEvidence.kind, 'interrupted');

      // A post-spawn setup failure, injected where it actually occurs.
      const postSpawn = yield* allocateLaunch(
        harness.dependencies(
          backendStub('node_pty', {
            launch: () =>
              Effect.fail(
                new PtyStartError({
                  command: 'pnpm',
                  cwd: '/repo/isagi',
                  cause: new Error('onData registration threw after the spawn'),
                }),
              ),
          }),
        ),
        { command: 'pnpm', args: ['judge'], cwd: '/repo/isagi' },
      );
      const postSpawnMetadata = yield* postSpawn.start;
      assert.equal(postSpawnMetadata.launchOutcome, 'spawn_failed');
      const postSpawnEvidence = classifyHeadlessEvidence({
        record: operation({ ptyProcessId: postSpawn.ptyProcessId, stage: 'launch_failed' }),
        receipt: receiptFor(postSpawn.ptyProcessId, {
          launchOutcome: postSpawnMetadata.launchOutcome,
          launchFailureCause: postSpawnMetadata.launchFailureCause,
        }),
        incarnationId: INCARNATION,
      });
      // `failed`, not `abandoned`: the process may be live right now, and redispatching under this
      // identity would put a second agent in the person's worktree.
      assert.equal(postSpawnEvidence.kind, 'confirmed_failure');
      assert.equal(
        postSpawnEvidence.kind === 'confirmed_failure' && postSpawnEvidence.ptyProcessId,
        postSpawn.ptyProcessId,
      );
    }),
  );
});

test('a row that reached prepareLaunch but never spawned still classifies from its own stage', async () => {
  await withHarness((harness) =>
    Effect.gen(function* () {
      const allocation = yield* allocateLaunch(
        harness.dependencies(
          backendStub('node_pty', {
            launch: () => Effect.die('this test stops before the spawn'),
          }),
        ),
        { command: 'pnpm', args: ['judge'], cwd: '/repo/isagi' },
      );
      // Allocation alone writes a *placeholder* backend ref; the row is inspectable either way. What
      // matters is that nothing about the row is consulted.
      const row = yield* harness.repository.findProcess(allocation.ptyProcessId);
      assert.ok(row, 'the durable row exists before any process does');
      assert.ok(row!.backendRefJson.length > 0, 'a decodable ref exists pre-spawn');

      const evidence = classifyHeadlessEvidence({
        record: operation({ ptyProcessId: allocation.ptyProcessId, stage: 'allocated' }),
        receipt: receiptFor(allocation.ptyProcessId),
        incarnationId: INCARNATION,
      });
      // An earlier draft treated a decodable, non-placeholder ref as proof of a spawn. It is not:
      // `prepareLaunch` writes the real ref *before* the spawn, precisely so the incarnation is
      // inspectable and killable.
      assert.equal(evidence.kind, 'abandon');
    }),
  );
});

test('workflow classification is unchanged by the PTY startup sweep, so no ordering is smuggled in', async () => {
  await withHarness((harness) =>
    Effect.gen(function* () {
      const allocation = yield* allocateLaunch(harness.dependencies(backendStub('node_pty')), {
        command: 'pnpm',
        args: ['judge'],
        cwd: '/repo/isagi',
      });
      yield* allocation.start;
      const record = operation({ ptyProcessId: allocation.ptyProcessId, stage: 'started' });
      const receipt = receiptFor(allocation.ptyProcessId, { launchOutcome: 'spawned' });

      const before = classifyHeadlessEvidence({
        record,
        receipt,
        incarnationId: 'a-different-incarnation',
      });

      // `reconcilePersistedProcesses(startup: true)` rewrites every live `node_pty` row to
      // `failed`/`runtime_ephemeral_lost`. A classifier that read process status would flip here.
      yield* reconcilePersistedProcesses(
        harness.repository,
        fakeBackendCatalog({
          configured: 'node_pty',
          nodePty: backendStub('node_pty'),
          tmux: backendStub('tmux'),
        }),
        publishOnlyRecordingEventBus('sweep does not subscribe').service,
        { terminations: new Map(), launches: new Map() },
        { startup: true },
      ).pipe(Effect.ignore);

      const after = classifyHeadlessEvidence({
        record,
        receipt,
        incarnationId: 'a-different-incarnation',
      });
      assert.equal(before.kind, 'interrupted');
      assert.deepEqual(after, before, 'the sweep cannot change what the operation itself recorded');
    }),
  );
});
