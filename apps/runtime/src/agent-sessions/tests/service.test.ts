import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Either, Layer } from 'effect';

import { PtyService, type PtyServiceShape } from '../../pty-processes/index.js';
import { InternalRuntimeEventBusLive } from '../../runtime-events/index.js';
import { SessionLifecycleLive } from '../../session-lifecycle/index.js';
import type { AgentSessionRow, PtyProcessRow } from '../../surfaces/index.js';
import {
  AgentSessionRepository,
  type AgentSessionRepositoryService,
} from '../agent-sessions.repository.js';
import { HarnessAdapterRegistry, type HarnessAdapterRegistryService } from '../harness/index.js';
import { AgentSessionError, AgentSessionService, AgentSessionServiceLive } from '../index.js';

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
      return yield* service.ensureActivePtyProcess(10).pipe(Effect.either);
    }).pipe(Effect.provide(testLayer({ state, launchInputs, ptyLaunches }))),
  );

  assert.equal(Either.isLeft(result), true);
  assert.equal(
    Either.isLeft(result) && result.left instanceof AgentSessionError
      ? result.left.code
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
      return yield* service.ensureActivePtyProcess(10).pipe(Effect.either);
    }).pipe(Effect.provide(testLayer({ state, launchInputs, ptyLaunches }))),
  );

  assert.equal(Either.isLeft(result), true);
  assert.equal(
    Either.isLeft(result) && result.left instanceof AgentSessionError
      ? result.left.code
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

function testLayer(input: {
  readonly state: ReturnType<typeof mutableAgentSession>;
  readonly launchInputs: RecordedLaunchInput[];
  readonly ptyLaunches: Array<{ command: string; args: readonly string[]; cwd: string }>;
}) {
  return AgentSessionServiceLive.pipe(
    Layer.provide(Layer.succeed(AgentSessionRepository, fakeRepository(input.state))),
    Layer.provide(Layer.succeed(PtyService, fakePtyService(input.ptyLaunches))),
    Layer.provide(Layer.succeed(HarnessAdapterRegistry, fakeHarnesses(input.launchInputs))),
    Layer.provide(SessionLifecycleLive),
    Layer.provide(InternalRuntimeEventBusLive),
  );
}

function fakeRepository(
  state: ReturnType<typeof mutableAgentSession>,
): AgentSessionRepositoryService {
  return {
    create: () => Effect.die('create is not used'),
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
    delete: () => Effect.die('delete is not used'),
  } satisfies AgentSessionRepositoryService;
}

function fakePtyService(
  ptyLaunches: Array<{ command: string; args: readonly string[]; cwd: string }>,
): PtyServiceShape {
  return {
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
    terminate: () => Effect.die('terminate is not used'),
    pin: () => Effect.void,
    unpin: () => Effect.void,
    isPinned: () => Effect.succeed(false),
  } satisfies PtyServiceShape;
}

function fakeHarnesses(launchInputs: RecordedLaunchInput[]): HarnessAdapterRegistryService {
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
  } satisfies HarnessAdapterRegistryService;
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
