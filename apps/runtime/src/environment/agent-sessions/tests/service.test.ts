import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Layer, Result } from 'effect';

import {
  HarnessLaunchBlocked,
  HarnessAdapterRegistry,
  type SdkHarness,
} from '../../../harnesses/index.js';
import {
  AllowAllHarnessControlPlaneLayer,
  blockedHarnessControlPlaneLayer,
} from '../../../harnesses/testing.js';
import { InternalEvents } from '../../../platform/events/index.js';
import { EntityLock } from '../../../platform/locks/index.js';
import { PtyService } from '../../../pty-processes/index.js';
import type { PtyProcessRow } from '../../../pty-processes/index.js';
import { fakeTerminateMany } from '../../../pty-processes/testing.js';
import { SessionLifecycle } from '../../sessions/lifecycle.js';
import type { AgentSessionRow } from '../../sessions/types.js';
import { AgentSessionRepository } from '../repository.js';
import { AgentSessionError, AgentSessionService } from '../service.js';

type RecordedLaunchInput = {
  readonly latestHarnessSessionId: string | null;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
};

test('agent session lifecycle launches a fresh process before any harness session id is observed', async () => {
  const state = mutableAgentSession({ activePtyProcessId: null, activePtyProcess: null });
  const launchInputs: RecordedLaunchInput[] = [];
  const ptyLaunches: Array<{ command: string; args: readonly string[]; cwd: string }> = [];

  const ptyProcessId = await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* AgentSessionService;
      return yield* service.ensureActivePtyProcess(10);
    }).pipe(Effect.provide(testLayer({ state, launchInputs, ptyLaunches }))),
  );

  assert.equal(ptyProcessId, 99);
  assert.deepEqual(launchInputs, [{ latestHarnessSessionId: null }]);
  assert.deepEqual(ptyLaunches, [{ command: 'pi', args: [], cwd: '/repo/isagi' }]);
  assert.equal(state.session.activePtyProcessId, 99);
});

test('agent session lifecycle forwards per-invocation model and effort to launch envelope', async () => {
  const state = mutableAgentSession({ activePtyProcessId: null, activePtyProcess: null });
  const launchInputs: RecordedLaunchInput[] = [];
  const ptyLaunches: Array<{ command: string; args: readonly string[]; cwd: string }> = [];

  const ptyProcessId = await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* AgentSessionService;
      return yield* service.ensureActivePtyProcess(10, {
        model: 'gpt-5.5',
        effort: 'medium',
      });
    }).pipe(Effect.provide(testLayer({ state, launchInputs, ptyLaunches }))),
  );

  assert.equal(ptyProcessId, 99);
  assert.deepEqual(launchInputs, [
    { latestHarnessSessionId: null, model: 'gpt-5.5', effort: 'medium' },
  ]);
});

test('agent session lifecycle resumes a dead previous process with the latest observed harness session id', async () => {
  const state = mutableAgentSession({
    activePtyProcessId: 20,
    harnessSessionId: 'pi-session-123',
    activePtyProcess: ptyProcess({
      id: 20,
      status: 'failed',
      statusReason: 'runtime_ephemeral_lost',
    }),
  });
  const launchInputs: RecordedLaunchInput[] = [];
  const ptyLaunches: Array<{ command: string; args: readonly string[]; cwd: string }> = [];

  const ptyProcessId = await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* AgentSessionService;
      return yield* service.ensureActivePtyProcess(10);
    }).pipe(Effect.provide(testLayer({ state, launchInputs, ptyLaunches }))),
  );

  assert.equal(ptyProcessId, 99);
  assert.deepEqual(launchInputs, [{ latestHarnessSessionId: 'pi-session-123' }]);
  assert.deepEqual(ptyLaunches, [
    { command: 'pi', args: ['--session', 'pi-session-123'], cwd: '/repo/isagi' },
  ]);
  assert.equal(state.session.activePtyProcessId, 99);
});

test('agent session lifecycle relaunches a dead previous process fresh without a harness session id', async () => {
  const state = mutableAgentSession({
    activePtyProcessId: 20,
    activePtyProcess: ptyProcess({
      id: 20,
      status: 'failed',
      statusReason: 'runtime_ephemeral_lost',
    }),
  });
  const launchInputs: RecordedLaunchInput[] = [];
  const ptyLaunches: Array<{ command: string; args: readonly string[]; cwd: string }> = [];

  const ptyProcessId = await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* AgentSessionService;
      return yield* service.ensureActivePtyProcess(10);
    }).pipe(Effect.provide(testLayer({ state, launchInputs, ptyLaunches }))),
  );

  assert.equal(ptyProcessId, 99);
  assert.deepEqual(launchInputs, [{ latestHarnessSessionId: null }]);
  assert.deepEqual(ptyLaunches, [{ command: 'pi', args: [], cwd: '/repo/isagi' }]);
  assert.equal(state.session.activePtyProcessId, 99);
});

test('agent session lifecycle refuses to launch when harness metadata is missing', async () => {
  const state = mutableAgentSession({
    activePtyProcessId: null,
    activePtyProcess: null,
    harnessMetadataStatus: 'missing',
    harnessMetadataDiagnostic: 'Harness metadata file is missing.',
  });
  const launchInputs: RecordedLaunchInput[] = [];
  const ptyLaunches: Array<{ command: string; args: readonly string[]; cwd: string }> = [];

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* AgentSessionService;
      return yield* service.ensureActivePtyProcess(10).pipe(Effect.result);
    }).pipe(Effect.provide(testLayer({ state, launchInputs, ptyLaunches }))),
  );

  assert.equal(Result.isFailure(result), true);
  assert.equal(
    Result.isFailure(result) && result.failure instanceof AgentSessionError
      ? result.failure.code
      : undefined,
    'harness_metadata_missing',
  );
  assert.deepEqual(launchInputs, []);
  assert.deepEqual(ptyLaunches, []);
});

test('agent session lifecycle refuses to launch when harness metadata is invalid', async () => {
  const state = mutableAgentSession({
    activePtyProcessId: null,
    activePtyProcess: null,
    harnessMetadataStatus: 'invalid',
    harnessMetadataDiagnostic: 'Invalid harness metadata.',
  });
  const launchInputs: RecordedLaunchInput[] = [];
  const ptyLaunches: Array<{ command: string; args: readonly string[]; cwd: string }> = [];

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* AgentSessionService;
      return yield* service.ensureActivePtyProcess(10).pipe(Effect.result);
    }).pipe(Effect.provide(testLayer({ state, launchInputs, ptyLaunches }))),
  );

  assert.equal(Result.isFailure(result), true);
  assert.equal(
    Result.isFailure(result) && result.failure instanceof AgentSessionError
      ? result.failure.code
      : undefined,
    'harness_metadata_invalid',
  );
  assert.deepEqual(launchInputs, []);
  assert.deepEqual(ptyLaunches, []);
});

test('agent session lifecycle reuses an active running process', async () => {
  const state = mutableAgentSession({
    activePtyProcessId: 20,
    activePtyProcess: ptyProcess({ id: 20, status: 'running', statusReason: null }),
  });
  const launchInputs: RecordedLaunchInput[] = [];
  const ptyLaunches: Array<{ command: string; args: readonly string[]; cwd: string }> = [];

  const ptyProcessId = await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* AgentSessionService;
      return yield* service.ensureActivePtyProcess(10);
    }).pipe(Effect.provide(testLayer({ state, launchInputs, ptyLaunches }))),
  );

  assert.equal(ptyProcessId, 20);
  assert.deepEqual(launchInputs, []);
  assert.deepEqual(ptyLaunches, []);
});

test('agent session creation checks policy before writing a durable row', async () => {
  const state = mutableAgentSession({ activePtyProcessId: null, activePtyProcess: null });
  const createCalls: number[] = [];
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* AgentSessionService;
      return yield* service
        .startFresh({ worktreeId: 1, harness: 'pi', cwd: '/repo/isagi' })
        .pipe(Effect.result);
    }).pipe(
      Effect.provide(
        testLayer({
          state,
          launchInputs: [],
          ptyLaunches: [],
          createCalls,
          controlPlaneLayer: blockedHarnessControlPlaneLayer('harness_disabled'),
        }),
      ),
    ),
  );
  assert.equal(Result.isFailure(result), true);
  assert.equal(
    Result.isFailure(result) && result.failure instanceof HarnessLaunchBlocked
      ? result.failure.reason
      : null,
    'harness_disabled',
  );
  assert.deepEqual(createCalls, []);
});

test('blocked policy allows reuse of a live process but rejects a relaunch', async () => {
  const running = mutableAgentSession({
    activePtyProcessId: 20,
    activePtyProcess: ptyProcess({ id: 20, status: 'running', statusReason: null }),
  });
  const blockedLayer = blockedHarnessControlPlaneLayer('harness_disabled');
  const reused = await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* AgentSessionService;
      return yield* service.ensureActivePtyProcess(10);
    }).pipe(
      Effect.provide(
        testLayer({
          state: running,
          launchInputs: [],
          ptyLaunches: [],
          controlPlaneLayer: blockedLayer,
        }),
      ),
    ),
  );
  assert.equal(reused, 20);

  running.session = {
    ...running.session,
    activePtyProcess: ptyProcess({
      id: 20,
      status: 'failed',
      statusReason: 'runtime_ephemeral_lost',
    }),
  };
  const relaunched = await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* AgentSessionService;
      return yield* service.ensureActivePtyProcess(10).pipe(Effect.result);
    }).pipe(
      Effect.provide(
        testLayer({
          state: running,
          launchInputs: [],
          ptyLaunches: [],
          controlPlaneLayer: blockedLayer,
        }),
      ),
    ),
  );
  assert.equal(Result.isFailure(relaunched), true);
  assert.equal(
    Result.isFailure(relaunched) && relaunched.failure instanceof HarnessLaunchBlocked
      ? relaunched.failure.reason
      : null,
    'harness_disabled',
  );
});

test('agent session startup restore replaces stale node-pty running process rows', async () => {
  const state = mutableAgentSession({
    activePtyProcessId: 20,
    harnessSessionId: 'pi-session-123',
    activePtyProcess: ptyProcess({ id: 20, status: 'running', statusReason: null }),
  });
  const launchInputs: RecordedLaunchInput[] = [];
  const ptyLaunches: Array<{ command: string; args: readonly string[]; cwd: string }> = [];

  const ptyProcessId = await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* AgentSessionService;
      return yield* service.ensureActivePtyProcess(10, { replaceEphemeralProcess: true });
    }).pipe(Effect.provide(testLayer({ state, launchInputs, ptyLaunches }))),
  );

  assert.equal(ptyProcessId, 99);
  assert.deepEqual(launchInputs, [{ latestHarnessSessionId: 'pi-session-123' }]);
  assert.deepEqual(ptyLaunches, [
    { command: 'pi', args: ['--session', 'pi-session-123'], cwd: '/repo/isagi' },
  ]);
  assert.equal(state.session.activePtyProcessId, 99);
});

test('stopUnlessPlaced leaves a placed session running and stops an unplaced one', async () => {
  const run = (input: {
    readonly placement: { readonly surfaceId: number; readonly paneId: number } | null;
    readonly terminate: PtyService['Service']['terminate'];
  }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* AgentSessionService;
        return yield* service.stopUnlessPlaced({ agentSessionId: 10, ptyProcessId: 42 });
      }).pipe(
        Effect.provide(
          testLayer({
            state: mutableAgentSession({}),
            launchInputs: [],
            ptyLaunches: [],
            placement: input.placement,
            terminate: input.terminate,
          }),
        ),
      ),
    );
  const stopped: number[] = [];
  const terminate: PtyService['Service']['terminate'] = (request) =>
    Effect.sync(() => {
      stopped.push(request.ptyProcessId);
      return 'terminated_live' as const;
    });

  assert.deepEqual(await run({ placement: { surfaceId: 9, paneId: 11 }, terminate }), {
    kind: 'placed',
    surfaceId: 9,
    paneId: 11,
  });
  assert.deepEqual(stopped, [], 'a placed session keeps its process');

  assert.deepEqual(await run({ placement: null, terminate }), { kind: 'stopped' });
  assert.deepEqual(stopped, [42]);

  const failed = await run({
    placement: null,
    terminate: () => Effect.fail(new Error('the backend refused the signal') as never),
  });
  assert.equal(failed.kind, 'stop_failed');
});

function testLayer(input: {
  readonly state: ReturnType<typeof mutableAgentSession>;
  readonly launchInputs: RecordedLaunchInput[];
  readonly ptyLaunches: Array<{ command: string; args: readonly string[]; cwd: string }>;
  readonly createCalls?: number[] | undefined;
  readonly controlPlaneLayer?: ReturnType<typeof blockedHarnessControlPlaneLayer> | undefined;
  readonly placement?: { readonly surfaceId: number; readonly paneId: number } | null | undefined;
  readonly terminate?: PtyService['Service']['terminate'] | undefined;
}) {
  return AgentSessionService.layerNoDeps.pipe(
    Layer.provide(
      Layer.succeed(
        AgentSessionRepository,
        fakeRepository(input.state, input.createCalls, input.placement),
      ),
    ),
    Layer.provide(Layer.succeed(PtyService, fakePtyService(input.ptyLaunches, input.terminate))),
    Layer.provide(Layer.succeed(HarnessAdapterRegistry, fakeHarnesses(input.launchInputs))),
    Layer.provide(SessionLifecycle.layerNoDeps.pipe(Layer.provide(EntityLock.layer))),
    Layer.provide(InternalEvents.layer),
    Layer.provide(input.controlPlaneLayer ?? AllowAllHarnessControlPlaneLayer),
  );
}

function fakeRepository(
  state: ReturnType<typeof mutableAgentSession>,
  createCalls: number[] = [],
  placement: { readonly surfaceId: number; readonly paneId: number } | null | undefined = undefined,
): AgentSessionRepository['Service'] {
  return {
    create: () =>
      Effect.sync(() => {
        createCalls.push(1);
        return 11;
      }),
    setActivePtyProcess: (input) =>
      Effect.sync(() => {
        state.session = {
          ...state.session,
          activePtyProcessId: input.ptyProcessId,
          activePtyProcess: ptyProcess({
            id: input.ptyProcessId,
            status: 'running',
            statusReason: null,
          }),
        };
      }),
    find: () => Effect.sync(() => state.session),
    findByActivePtyProcessId: () => Effect.die('findByActivePtyProcessId is not used'),
    listOrphans: () => Effect.die('listOrphans is not used'),
    listIds: Effect.die('listIds is not used'),
    delete: () => Effect.die('delete is not used'),
    findPlacement: () =>
      placement === undefined ? Effect.die('findPlacement is not used') : Effect.succeed(placement),
  } satisfies AgentSessionRepository['Service'];
}

function fakePtyService(
  ptyLaunches: Array<{ command: string; args: readonly string[]; cwd: string }>,
  terminate: PtyService['Service']['terminate'] = () => Effect.die('terminate is not used'),
): PtyService['Service'] {
  return {
    allocateLaunch: () => Effect.die('pty allocateLaunch is not used'),
    readLogTail: () => Effect.die('readLogTail is not used'),
    launch: (input) =>
      Effect.sync(() => {
        ptyLaunches.push({ command: input.command, args: input.args, cwd: input.cwd });
        return {
          ptyProcessId: 99,
          command: input.command,
          args: input.args,
          cwd: input.cwd,
          logPath: null,
        };
      }),
    getAttachmentPlan: () => Effect.die('getAttachmentPlan is not used'),
    attach: () => Effect.die('attach is not used'),
    replay: () => Effect.die('replay is not used'),
    write: () => Effect.die('write is not used'),
    writeInput: () => Effect.die('writeInput is not used'),
    resize: () => Effect.die('resize is not used'),
    kill: () => Effect.die('kill is not used'),
    terminate,
    terminateMany: fakeTerminateMany(terminate),
    findProcess: () => Effect.die('findProcess is not used'),
    pin: () => Effect.void,
    unpin: () => Effect.void,
    cleanupProcess: () => Effect.die('pty cleanupProcess is not used'),
    isPinned: () => Effect.succeed(false),
  } satisfies PtyService['Service'];
}

function fakeHarnesses(launchInputs: RecordedLaunchInput[]): HarnessAdapterRegistry['Service'] {
  return {
    buildLaunch: (input) =>
      Effect.sync(() => {
        const recorded: RecordedLaunchInput = {
          latestHarnessSessionId: input.latestHarnessSessionId,
        };
        if (input.model !== undefined || input.effort !== undefined) {
          launchInputs.push({ ...recorded, model: input.model, effort: input.effort });
        } else {
          launchInputs.push(recorded);
        }
        return {
          command: 'pi',
          args: input.latestHarnessSessionId ? ['--session', input.latestHarnessSessionId] : [],
          cwd: input.cwd,
        };
      }),
    buildHeadlessLaunch: () => Effect.die('buildHeadlessLaunch is not used'),
    supportsSdk: (_harness): _harness is SdkHarness => false,
    buildSdkInstrumentation: () => Effect.die('buildSdkInstrumentation is not used'),
  } satisfies HarnessAdapterRegistry['Service'];
}

function mutableAgentSession(
  input: Partial<
    Pick<
      AgentSessionRow,
      | 'activePtyProcessId'
      | 'harnessSessionId'
      | 'harnessMetadataStatus'
      | 'harnessMetadataDiagnostic'
      | 'activePtyProcess'
    >
  >,
) {
  return {
    session: {
      id: 10,
      worktreeId: 1,
      harness: 'pi',
      cwd: '/repo/isagi',
      harnessSessionId: input.harnessSessionId ?? null,
      harnessMetadataStatus: input.harnessMetadataStatus ?? 'valid',
      harnessMetadataDiagnostic: input.harnessMetadataDiagnostic ?? null,
      activePtyProcessId: input.activePtyProcessId ?? null,
      createdAt: '2026-06-16T00:00:00.000Z',
      updatedAt: '2026-06-16T00:00:00.000Z',
      lastSeenAt: null,
      activePtyProcess: input.activePtyProcess ?? null,
    } satisfies AgentSessionRow,
  };
}

function ptyProcess(input: {
  readonly id: number;
  readonly status: PtyProcessRow['status'];
  readonly statusReason: PtyProcessRow['statusReason'];
}): PtyProcessRow {
  return {
    id: input.id,
    backend: 'node_pty',
    backendRefJson: JSON.stringify({
      schemaVersion: 1,
      backend: 'node_pty',
      ptyProcessId: input.id,
      pid: 1234,
    }),
    command: 'pi',
    args: [],
    argsJson: '[]',
    cwd: '/repo/isagi',
    status: input.status,
    statusReason: input.statusReason,
    exitCode: null,
    signal: null,
    logMode: 'none',
    logPath: null,
    createdAt: '2026-06-16T00:00:00.000Z',
    updatedAt: '2026-06-16T00:00:00.000Z',
    exitedAt: null,
    lastSeenAt: null,
  };
}
