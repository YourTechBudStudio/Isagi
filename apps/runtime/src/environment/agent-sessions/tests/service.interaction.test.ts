import assert from 'node:assert/strict';
import test from 'node:test';

import { Deferred, Effect, Fiber, Layer, Scope, Exit } from 'effect';

import { makeLogCapture } from '../../../../test/test-support.js';
import {
  FluidcastSessions,
  FluidcastStartFailed,
  FluidcastUnavailable,
  type FluidcastAvailability,
} from '../../../fluidcast/index.js';
import {
  hangingFluidcastSessionsLayer,
  makeFakeFluidcastSessions,
  type FakeFluidcastSessions,
} from '../../../fluidcast/testing.js';
import {
  AgentSessionArtifacts,
  HarnessAdapterRegistry,
  HarnessLaunchBlocked,
  type SdkHarness,
} from '../../../harnesses/index.js';
import {
  AgentSessionArtifactError,
  AllowAllHarnessControlPlaneLayer,
  blockedHarnessControlPlaneLayer,
} from '../../../harnesses/testing.js';
import type { InternalEvent } from '../../../platform/events/index.js';
import { publishOnlyRecordingEventBus } from '../../../platform/events/testing.js';
import { EntityLock } from '../../../platform/locks/index.js';
import { PtyService, type PtyProcessRow } from '../../../pty-processes/index.js';
import { fakeTerminateMany } from '../../../pty-processes/testing.js';
import { SessionLifecycle } from '../../sessions/lifecycle.js';
import type { AgentSessionRow } from '../../sessions/types.js';
import { AgentSessionInteraction } from '../interaction.js';
import { AgentSessionRepository } from '../repository.js';
import { AgentSessionError, AgentSessionService } from '../service.js';

// The mode change and release over fakes that record one ordered log: PTY terminates and
// launches, Fluidcast starts and stops, native-ID writes. Holds come from the real interaction.

type Placement = { readonly surfaceId: number; readonly paneId: number };

interface World {
  readonly rows: Map<number, AgentSessionRow>;
  readonly placements: Map<number, Placement | null>;
  readonly log: string[];
  readonly launches: Array<{ readonly agentSessionId: number; readonly resume: string | null }>;
  readonly writes: Array<{ readonly agentSessionId: number; readonly harnessSessionId: string }>;
  readonly events: InternalEvent[];
}

interface WorldOptions {
  readonly agents?: ReadonlyArray<Partial<AgentSessionRow> & { readonly id: number }>;
  readonly fluidcast?: FakeFluidcastSessions;
  readonly fluidcastLayer?: Layer.Layer<FluidcastSessions>;
  readonly availability?: FluidcastAvailability;
  readonly controlPlane?: ReturnType<typeof blockedHarnessControlPlaneLayer>;
  readonly writeFails?: boolean;
  /** Runs inside `pty.launch` before it returns: hold it with a `Deferred`. */
  readonly onLaunch?: (agentSessionId: number) => Effect.Effect<void>;
}

function makeWorld(options: WorldOptions = {}) {
  const log: string[] = [];
  const world: World = {
    rows: new Map(),
    placements: new Map(),
    log,
    launches: [],
    writes: [],
    events: [],
  };
  for (const agent of options.agents ?? [{ id: 10 }]) {
    world.rows.set(agent.id, agentRow(agent));
    world.placements.set(agent.id, { surfaceId: 1, paneId: agent.id });
  }
  const fluidcast =
    options.fluidcast ??
    makeFakeFluidcastSessions({ availability: options.availability ?? 'ready', log });
  const fluidcastLayer = options.fluidcastLayer ?? fluidcast.layer;
  const bus = publishOnlyRecordingEventBus('AgentSessionService does not subscribe');
  let nextPty = 100;

  const setPtyStatus = (ptyProcessId: number, status: PtyProcessRow['status']) => {
    for (const [id, row] of world.rows)
      if (row.activePtyProcessId === ptyProcessId && row.activePtyProcess)
        world.rows.set(id, { ...row, activePtyProcess: { ...row.activePtyProcess, status } });
  };

  const terminate: PtyService['Service']['terminate'] = (input) =>
    Effect.sync(() => {
      log.push(`pty.terminate:${input.ptyProcessId}`);
      setPtyStatus(input.ptyProcessId, 'killed');
      return 'terminated_live' as const;
    });

  const pty = PtyService.of({
    allocateLaunch: () => Effect.die('allocateLaunch is not used'),
    readLogTail: () => Effect.die('readLogTail is not used'),
    launch: (input) =>
      Effect.gen(function* () {
        const agentSessionId = Number(input.cwd.split(':')[1]);
        if (options.onLaunch) yield* options.onLaunch(agentSessionId);
        const ptyProcessId = nextPty++;
        log.push(`pty.launch:${ptyProcessId}`);
        return {
          ptyProcessId,
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
    cleanupProcess: () => Effect.die('cleanupProcess is not used'),
    isPinned: () => Effect.succeed(false),
  });

  const repository = AgentSessionRepository.of({
    create: () => Effect.die('create is not used'),
    setActivePtyProcess: (input) =>
      Effect.sync(() => {
        const row = world.rows.get(input.agentSessionId)!;
        world.rows.set(input.agentSessionId, {
          ...row,
          activePtyProcessId: input.ptyProcessId,
          activePtyProcess: ptyRow(input.ptyProcessId, 'running'),
        });
      }),
    find: (id) => Effect.sync(() => world.rows.get(id) ?? null),
    findByActivePtyProcessId: () => Effect.die('findByActivePtyProcessId is not used'),
    listOrphans: () => Effect.die('listOrphans is not used'),
    listIds: Effect.die('listIds is not used'),
    delete: () => Effect.die('delete is not used'),
    findPlacement: (id) => Effect.sync(() => world.placements.get(id) ?? null),
    // Worktree N belongs to project 100 + N.
    findProjectId: (worktreeId) => Effect.succeed(100 + worktreeId),
  });

  const harnesses = HarnessAdapterRegistry.of({
    buildLaunch: (input) =>
      Effect.sync(() => {
        world.launches.push({
          agentSessionId: input.agentSessionId,
          resume: input.latestHarnessSessionId,
        });
        // The agent's id rides in `cwd` so the PTY fake can attribute a held launch.
        return { command: input.harness, args: [], cwd: `agent:${input.agentSessionId}` };
      }),
    buildHeadlessLaunch: () => Effect.die('buildHeadlessLaunch is not used'),
    supportsSdk: (harness): harness is SdkHarness => harness === 'claude' || harness === 'codex',
    buildSdkInstrumentation: () => Effect.die('buildSdkInstrumentation is not used'),
  });

  const artifacts = Layer.mock(AgentSessionArtifacts)({
    paths: () => assert.fail('artifact paths are not used'),
    writeHarnessSessionId: (input) =>
      options.writeFails
        ? Effect.fail(
            new AgentSessionArtifactError({
              code: 'metadata_write_failed',
              agentSessionId: input.agentSessionId,
              path: '/data/harness.json',
              cause: new Error('disk full'),
            }),
          )
        : Effect.sync(() => {
            log.push(`write:${input.harnessSessionId}`);
            world.writes.push(input);
            const row = world.rows.get(input.agentSessionId)!;
            world.rows.set(input.agentSessionId, {
              ...row,
              harnessSessionId: input.harnessSessionId,
            });
          }),
  });

  const interaction = AgentSessionInteraction.layerNoDeps.pipe(Layer.provide(fluidcastLayer));
  const layer = AgentSessionService.layerNoDeps.pipe(
    Layer.provide(Layer.succeed(AgentSessionRepository, repository)),
    Layer.provide(Layer.succeed(PtyService, pty)),
    Layer.provide(Layer.succeed(HarnessAdapterRegistry, harnesses)),
    Layer.provide(SessionLifecycle.layerNoDeps.pipe(Layer.provide(EntityLock.layer))),
    Layer.provide(bus.layer),
    Layer.provide(options.controlPlane ?? AllowAllHarnessControlPlaneLayer),
    Layer.provide(artifacts),
    Layer.provide(interaction),
    Layer.provide(fluidcastLayer),
    Layer.provideMerge(interaction),
  );

  return {
    world: { ...world, events: bus.events },
    fluidcast,
    run: <A, E>(
      body: Effect.Effect<A, E, AgentSessionService | AgentSessionInteraction | Scope.Scope>,
    ) => Effect.runPromise(Effect.scoped(body).pipe(Effect.provide(layer))),
  };
}

function agentRow(input: Partial<AgentSessionRow> & { readonly id: number }): AgentSessionRow {
  const ptyProcessId =
    input.activePtyProcessId === undefined ? 20 + input.id : input.activePtyProcessId;
  return {
    worktreeId: 1,
    harness: 'claude',
    cwd: '/repo',
    harnessSessionId: 'claude-session',
    harnessMetadataStatus: 'valid',
    harnessMetadataDiagnostic: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    lastSeenAt: null,
    activePtyProcessId: ptyProcessId,
    activePtyProcess: ptyProcessId === null ? null : ptyRow(ptyProcessId, 'running'),
    ...input,
  };
}

function ptyRow(id: number, status: PtyProcessRow['status']): PtyProcessRow {
  return {
    id,
    backend: 'node_pty',
    backendRefJson: '{}',
    command: 'claude',
    args: [],
    argsJson: '[]',
    cwd: '/repo',
    status,
    statusReason: null,
    exitCode: null,
    signal: null,
    logMode: 'none',
    logPath: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    exitedAt: null,
    lastSeenAt: null,
  };
}

/** Each `switched` interval's incarnation, in publication order. */
function switches(events: readonly InternalEvent[], agentSessionId = 10) {
  return events.flatMap((event) =>
    event.type === 'agent_session_execution_changed' &&
    event.agentSessionId === agentSessionId &&
    event.change._tag === 'switched'
      ? [event.change.interval.incarnation]
      : [],
  );
}

function changedCount(events: readonly InternalEvent[], agentSessionId = 10) {
  return events.filter(
    (event) => event.type === 'agent_session_changed' && event.agentSessionId === agentSessionId,
  ).length;
}

const toFluidcast = (agentSessionId = 10) =>
  AgentSessionService.use((agents) =>
    agents.setInteractionMode({ agentSessionId, mode: 'fluidcast' }),
  );
const toTerminal = (agentSessionId = 10) =>
  AgentSessionService.use((agents) =>
    agents.setInteractionMode({ agentSessionId, mode: 'terminal' }),
  );
const release = (ids: ReadonlyArray<number>) =>
  AgentSessionService.use((agents) => agents.releaseControllers(ids));

/** Polls `condition` until it holds, or dies after `ms`. */
const eventually = (condition: () => boolean, ms = 2_000) =>
  Effect.gen(function* () {
    for (let waited = 0; !condition(); waited += 5) {
      if (waited >= ms) return yield* Effect.die(new Error('condition never held'));
      yield* Effect.sleep('5 millis');
    }
  });

// ── Terminal → Fluidcast ─────────────────────────────────────────────────────

test('switching to Fluidcast stops the terminal before the session starts, then records and publishes it', async () => {
  const { world, fluidcast, run } = makeWorld();
  const result = await run(
    Effect.gen(function* () {
      const switched = yield* toFluidcast();
      const interaction = yield* AgentSessionInteraction;
      return { switched, interaction: interaction.get(10) };
    }),
  );
  assert.deepEqual(result.switched, { mode: 'fluidcast', fluidcastSessionId: 'fc-1' });
  assert.deepEqual(result.interaction, { mode: 'fluidcast', fluidcastSessionId: 'fc-1' });
  assert.deepEqual(world.log, ['pty.terminate:30', 'fluidcast.start:10']);
  assert.deepEqual(fluidcast.calls[0], {
    kind: 'start',
    input: {
      agentSessionId: 10,
      harness: 'claude',
      cwd: '/repo',
      harnessSessionId: 'claude-session',
    },
  });
  assert.deepEqual(switches(world.events), ['sdk:fc-1']);
  assert.equal(changedCount(world.events), 1);
  // The persisted pointer stays on the stopped terminal; the interaction overrides it.
  assert.equal(world.rows.get(10)?.activePtyProcessId, 30);
});

test('switching to Fluidcast twice is idempotent', async () => {
  const { world, fluidcast, run } = makeWorld();
  const [first, second] = await run(Effect.all([toFluidcast(), toFluidcast()]));
  assert.deepEqual(first, second);
  assert.equal(fluidcast.calls.length, 1);
  assert.deepEqual(switches(world.events), ['sdk:fc-1']);
});

test('a terminal that already ended is not terminated again before the start', async () => {
  const { world, run } = makeWorld({
    agents: [{ id: 10, activePtyProcessId: 30, activePtyProcess: ptyRow(30, 'exited') }],
  });
  await run(toFluidcast());
  assert.deepEqual(world.log, ['fluidcast.start:10']);
});

test('every refusal happens before anything stops, and leaves the terminal running', async () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly options: WorldOptions;
    readonly prepare?: Effect.Effect<void, never, AgentSessionInteraction | Scope.Scope>;
    readonly check: (error: unknown) => void;
  }> = [
    {
      name: 'invalid metadata',
      options: { agents: [{ id: 10, harnessMetadataStatus: 'invalid' }] },
      check: (error) => {
        assert.ok(error instanceof AgentSessionError);
        assert.equal(error.code, 'harness_metadata_invalid');
      },
    },
    {
      name: 'missing metadata',
      options: { agents: [{ id: 10, harnessMetadataStatus: 'missing' }] },
      check: (error) => {
        assert.ok(error instanceof AgentSessionError);
        assert.equal(error.code, 'harness_metadata_missing');
      },
    },
    {
      name: 'Fluidcast disabled',
      options: { availability: 'disabled' },
      check: (error) => {
        assert.ok(error instanceof FluidcastUnavailable);
        assert.equal(error.reason, 'disabled');
      },
    },
    {
      name: 'invalid Fluidcast config',
      options: { availability: 'invalid' },
      check: (error) => {
        assert.ok(error instanceof FluidcastUnavailable);
        assert.equal(error.reason, 'invalid_config');
      },
    },
    {
      name: 'a harness with no SDK worker',
      options: { agents: [{ id: 10, harness: 'pi' }] },
      check: (error) => {
        assert.ok(error instanceof FluidcastUnavailable);
        assert.equal(error.reason, 'harness_unsupported');
      },
    },
    {
      name: 'a blocked launch',
      options: { controlPlane: blockedHarnessControlPlaneLayer('harness_disabled') },
      check: (error) => {
        assert.ok(error instanceof HarnessLaunchBlocked);
        assert.equal(error.reason, 'harness_disabled');
      },
    },
    {
      name: 'no placement',
      options: {},
      check: (error) => {
        assert.ok(error instanceof AgentSessionError);
        assert.equal(error.code, 'session_not_placed');
      },
    },
    {
      name: 'a deletion hold',
      options: {},
      prepare: Effect.flatMap(AgentSessionInteraction, (interaction) =>
        interaction.holdForDeletion([{ worktreeId: 1 }]),
      ),
      check: (error) => {
        assert.ok(error instanceof AgentSessionError);
        assert.equal(error.code, 'session_deleting');
      },
    },
  ];
  for (const testCase of cases) {
    const { world, run } = makeWorld(testCase.options);
    if (testCase.name === 'no placement') world.placements.set(10, null);
    const error = await run(
      Effect.gen(function* () {
        if (testCase.prepare) yield* testCase.prepare;
        return yield* Effect.flip(toFluidcast());
      }),
    );
    testCase.check(error);
    assert.deepEqual(world.log, [], testCase.name);
    assert.equal(world.rows.get(10)?.activePtyProcess?.status, 'running', testCase.name);
    assert.deepEqual(switches(world.events), [], testCase.name);
  }
});

test('a failed start leaves terminal mode with the terminal stopped, and publishes a null interval', async () => {
  const fluidcast = makeFakeFluidcastSessions({
    onStart: () => Effect.fail(new FluidcastStartFailed({ reason: 'executable_not_found' })),
  });
  const { world, run } = makeWorld({ fluidcast });
  const result = await run(
    Effect.gen(function* () {
      const error = yield* Effect.flip(toFluidcast());
      return { error, interaction: (yield* AgentSessionInteraction).get(10) };
    }),
  );
  assert.ok(result.error instanceof FluidcastStartFailed);
  assert.deepEqual(result.interaction, { mode: 'terminal' });
  assert.equal(world.rows.get(10)?.activePtyProcess?.status, 'killed');
  assert.deepEqual(switches(world.events), [null]);
  assert.equal(changedCount(world.events), 1);
});

test('a start that hangs is bounded inside the uninterruptible switch', async () => {
  const { world, run } = makeWorld({ fluidcastLayer: hangingFluidcastSessionsLayer('30 millis') });
  const logs = makeLogCapture();
  const result = await run(
    Effect.gen(function* () {
      const error = yield* Effect.flip(toFluidcast());
      return { error, interaction: (yield* AgentSessionInteraction).get(10) };
    }).pipe(Effect.provide(logs.layer)),
  );
  assert.ok(result.error instanceof FluidcastStartFailed);
  assert.equal(result.error.reason, 'session_build_failed');
  assert.deepEqual(result.interaction, { mode: 'terminal' });
  assert.deepEqual(switches(world.events), [null]);
});

// ── Fluidcast → terminal ─────────────────────────────────────────────────────

test('switching back to terminal stops the session and resumes the persisted native session', async () => {
  const { world, run } = makeWorld();
  const result = await run(Effect.andThen(toFluidcast(), toTerminal()));
  assert.deepEqual(result, { mode: 'terminal', fluidcastSessionId: null });
  assert.deepEqual(world.log, [
    'pty.terminate:30',
    'fluidcast.start:10',
    'fluidcast.stop:fc-1',
    'pty.launch:100',
  ]);
  assert.deepEqual(world.launches, [{ agentSessionId: 10, resume: 'claude-session' }]);
  assert.deepEqual(world.writes, []);
  assert.deepEqual(switches(world.events), ['sdk:fc-1', 'pty:100']);
  assert.equal(world.rows.get(10)?.activePtyProcessId, 100);
});

test('a native ID the worker reported but nobody persisted is written and resumed', async () => {
  const fluidcast = makeFakeFluidcastSessions({ finalHarnessSessionId: () => 'new-thread' });
  const { world, run } = makeWorld({ fluidcast, agents: [{ id: 10, harnessSessionId: null }] });
  await run(Effect.andThen(toFluidcast(), toTerminal()));
  assert.deepEqual(world.writes, [{ agentSessionId: 10, harnessSessionId: 'new-thread' }]);
  assert.deepEqual(world.launches, [{ agentSessionId: 10, resume: 'new-thread' }]);
  assert.ok(world.log.indexOf('write:new-thread') < world.log.indexOf('pty.launch:100'));
});

test('a failed native-ID write is a warning, and the terminal still resumes that ID', async () => {
  const fluidcast = makeFakeFluidcastSessions({ finalHarnessSessionId: () => 'new-thread' });
  const { world, run } = makeWorld({
    fluidcast,
    writeFails: true,
    agents: [{ id: 10, harnessSessionId: null }],
  });
  const logs = makeLogCapture();
  await run(Effect.andThen(toFluidcast(), toTerminal()).pipe(Effect.provide(logs.layer)));
  assert.deepEqual(world.launches, [{ agentSessionId: 10, resume: 'new-thread' }]);
  const warnings = logs.lines.filter(
    (line) => line.message === 'agent native session id not recorded',
  );
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.annotations.agentSessionId, 10);
  assert.equal(warnings[0]?.annotations.reason, 'metadata_write_failed');
  assert.equal(JSON.stringify(warnings).includes('disk full'), false);
});

test('a worker that never reported a native session gives a fresh terminal', async () => {
  const fluidcast = makeFakeFluidcastSessions({ finalHarnessSessionId: () => null });
  const { world, run } = makeWorld({ fluidcast, agents: [{ id: 10, harnessSessionId: null }] });
  await run(Effect.andThen(toFluidcast(), toTerminal()));
  assert.deepEqual(world.writes, []);
  assert.deepEqual(world.launches, [{ agentSessionId: 10, resume: null }]);
});

test('a failed terminal launch after the stop publishes a null interval', async () => {
  const { world, run } = makeWorld();
  const result = await run(
    Effect.gen(function* () {
      yield* toFluidcast();
      // The harness becomes unusable while the agent is under Fluidcast control.
      world.rows.set(10, { ...world.rows.get(10)!, harnessMetadataStatus: 'invalid' });
      const error = yield* Effect.flip(toTerminal());
      return { error, interaction: (yield* AgentSessionInteraction).get(10) };
    }),
  );
  assert.ok(result.error instanceof AgentSessionError);
  assert.deepEqual(result.interaction, { mode: 'terminal' });
  assert.deepEqual(switches(world.events), ['sdk:fc-1', null]);
});

test('switching to terminal is idempotent while the terminal runs, and relaunches one that ended', async () => {
  const running = makeWorld();
  const result = await running.run(toTerminal());
  assert.deepEqual(result, { mode: 'terminal', fluidcastSessionId: null });
  assert.deepEqual(running.world.log, []);

  const ended = makeWorld({
    agents: [{ id: 10, activePtyProcessId: 30, activePtyProcess: ptyRow(30, 'exited') }],
  });
  await ended.run(toTerminal());
  assert.deepEqual(ended.world.log, ['pty.launch:100']);
  assert.deepEqual(switches(ended.world.events), ['pty:100']);
});

test('a terminal switch for an agent no pane holds is refused before anything stops', async () => {
  const { world, fluidcast, run } = makeWorld();
  const error = await run(
    Effect.gen(function* () {
      yield* toFluidcast();
      world.placements.set(10, null);
      return yield* Effect.flip(toTerminal());
    }),
  );
  assert.ok(error instanceof AgentSessionError);
  assert.equal(error.code, 'session_not_placed');
  assert.deepEqual(fluidcast.live(), ['fc-1']);
});

// ── Concurrency and interruption ─────────────────────────────────────────────

test('two agents switch concurrently while one start is held', async () => {
  const held = Effect.runSync(Deferred.make<void>());
  const log: string[] = [];
  const fluidcast = makeFakeFluidcastSessions({
    log,
    onStart: (input) => (input.agentSessionId === 10 ? Deferred.await(held) : Effect.void),
  });
  const { run } = makeWorld({ fluidcast, agents: [{ id: 10 }, { id: 11 }] });
  const result = await run(
    Effect.gen(function* () {
      const first = yield* Effect.forkChild(toFluidcast(10));
      yield* eventually(() => log.includes('fluidcast.start:10'));
      const second = yield* toFluidcast(11);
      const startedWhileHeld = fluidcast.live();
      yield* Deferred.succeed(held, undefined);
      return { first: yield* Fiber.join(first), second, startedWhileHeld };
    }),
  );
  assert.deepEqual(result.startedWhileHeld, ['fc-1']);
  assert.equal(result.second.fluidcastSessionId, 'fc-1');
  assert.equal(result.first.fluidcastSessionId, 'fc-2');
});

test("one agent's switches serialize behind its lock", async () => {
  const held = Effect.runSync(Deferred.make<void>());
  const log: string[] = [];
  const fluidcast = makeFakeFluidcastSessions({ log, onStart: () => Deferred.await(held) });
  const { world, run } = makeWorld({ fluidcast });
  await run(
    Effect.gen(function* () {
      const first = yield* Effect.forkChild(toFluidcast());
      yield* eventually(() => log.includes('fluidcast.start:10'));
      const second = yield* Effect.forkChild(toTerminal());
      yield* Effect.sleep('20 millis');
      // The terminal switch waits for the lock; it has not stopped the session being started.
      assert.equal(fluidcast.calls.filter((call) => call.kind === 'stop').length, 0);
      yield* Deferred.succeed(held, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
    }),
  );
  assert.deepEqual(switches(world.events), ['sdk:fc-1', 'pty:100']);
});

test("a caller's interruption does not cut a switch that holds the lock", async () => {
  const held = Effect.runSync(Deferred.make<void>());
  const log: string[] = [];
  const fluidcast = makeFakeFluidcastSessions({ log, onStart: () => Deferred.await(held) });
  const { world, run } = makeWorld({ fluidcast });
  const interaction = await run(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(toFluidcast());
      yield* eventually(() => log.includes('fluidcast.start:10'));
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber));
      yield* Deferred.succeed(held, undefined);
      yield* Fiber.join(interrupting);
      return (yield* AgentSessionInteraction).get(10);
    }),
  );
  assert.deepEqual(interaction, { mode: 'fluidcast', fluidcastSessionId: 'fc-1' });
  assert.deepEqual(switches(world.events), ['sdk:fc-1']);
});

test('a caller interrupted while waiting for the lock does not run its switch later', async () => {
  const held = Effect.runSync(Deferred.make<void>());
  const log: string[] = [];
  const fluidcast = makeFakeFluidcastSessions({ log, onStart: () => Deferred.await(held) });
  const { world, run } = makeWorld({ fluidcast });
  await run(
    Effect.gen(function* () {
      const first = yield* Effect.forkChild(toFluidcast());
      yield* eventually(() => log.includes('fluidcast.start:10'));
      const queued = yield* Effect.forkChild(toTerminal());
      yield* Effect.sleep('10 millis');
      yield* Fiber.interrupt(queued);
      yield* Deferred.succeed(held, undefined);
      yield* Fiber.join(first);
    }),
  );
  assert.deepEqual(switches(world.events), ['sdk:fc-1']);
  assert.equal(fluidcast.live().length, 1);
});

// ── Release and holds ────────────────────────────────────────────────────────

test('release stops a hidden Fluidcast session and is idempotent', async () => {
  const { world, fluidcast, run } = makeWorld();
  const interaction = await run(
    Effect.gen(function* () {
      yield* toFluidcast();
      yield* release([10]);
      yield* release([10]);
      return (yield* AgentSessionInteraction).get(10);
    }),
  );
  assert.deepEqual(interaction, { mode: 'terminal' });
  assert.deepEqual(fluidcast.live(), []);
  // The stopped terminal is not terminated again, and the second release ends nothing.
  assert.deepEqual(world.log, ['pty.terminate:30', 'fluidcast.start:10', 'fluidcast.stop:fc-1']);
  assert.deepEqual(switches(world.events), ['sdk:fc-1', null]);
});

test('release terminates a running terminal and publishes one null interval per ended agent', async () => {
  const { world, run } = makeWorld({ agents: [{ id: 10 }, { id: 11, activePtyProcessId: null }] });
  await run(release([10, 11]));
  assert.deepEqual(world.log, ['pty.terminate:30']);
  assert.deepEqual(switches(world.events, 10), [null]);
  assert.deepEqual(switches(world.events, 11), []);
});

test('a Fluidcast start holding the lock when a pane delete releases it completes and is then stopped', async () => {
  const held = Effect.runSync(Deferred.make<void>());
  const log: string[] = [];
  const fluidcast = makeFakeFluidcastSessions({ log, onStart: () => Deferred.await(held) });
  const { world, run } = makeWorld({ fluidcast });
  const after = await run(
    Effect.gen(function* () {
      const switching = yield* Effect.forkChild(toFluidcast());
      yield* eventually(() => log.includes('fluidcast.start:10'));
      // The pane delete commits, then releases.
      world.placements.set(10, null);
      const releasing = yield* Effect.forkChild(release([10]));
      yield* Deferred.succeed(held, undefined);
      yield* Fiber.join(switching);
      yield* Fiber.join(releasing);
      return {
        interaction: (yield* AgentSessionInteraction).get(10),
        later: yield* Effect.flip(toFluidcast()),
      };
    }),
  );
  assert.deepEqual(after.interaction, { mode: 'terminal' });
  assert.deepEqual(fluidcast.live(), []);
  assert.ok(after.later instanceof AgentSessionError);
  assert.equal(after.later.code, 'session_not_placed');
  assert.deepEqual(switches(world.events), ['sdk:fc-1', null]);
});

test('release ends the terminal a switch back launched after the delete read its pointers', async () => {
  const held = Effect.runSync(Deferred.make<void>());
  const log: string[] = [];
  const fluidcast = makeFakeFluidcastSessions({ log, onStop: () => Deferred.await(held) });
  const { world, run } = makeWorld({ fluidcast });
  await run(
    Effect.gen(function* () {
      yield* toFluidcast();
      const switching = yield* Effect.forkChild(toTerminal());
      yield* eventually(() => log.includes('fluidcast.stop:fc-1'));
      // The pane delete commits while the Fluidcast teardown is held, then releases.
      world.placements.set(10, null);
      const releasing = yield* Effect.forkChild(release([10]));
      yield* Deferred.succeed(held, undefined);
      yield* Fiber.join(switching);
      yield* Fiber.join(releasing);
    }),
  );
  assert.deepEqual(world.log.slice(-2), ['pty.launch:100', 'pty.terminate:100']);
  assert.deepEqual(switches(world.events), ['sdk:fc-1', 'pty:100', null]);
});

test('a switch queued behind a pane delete is refused in both directions', async () => {
  for (const direction of ['fluidcast', 'terminal'] as const) {
    const { world, run } = makeWorld({
      agents: [{ id: 10, activePtyProcessId: 30, activePtyProcess: ptyRow(30, 'exited') }],
    });
    const error = await run(
      Effect.gen(function* () {
        world.placements.set(10, null);
        yield* release([10]);
        return yield* Effect.flip(direction === 'fluidcast' ? toFluidcast() : toTerminal());
      }),
    );
    assert.ok(error instanceof AgentSessionError);
    assert.equal(error.code, 'session_not_placed', direction);
    assert.deepEqual(world.log, [], direction);
  }
});

test('a re-placed agent can switch again', async () => {
  const { world, run } = makeWorld();
  const result = await run(
    Effect.gen(function* () {
      world.placements.set(10, null);
      const refused = yield* Effect.flip(toFluidcast());
      world.placements.set(10, { surfaceId: 2, paneId: 5 });
      return { refused, switched: yield* toFluidcast() };
    }),
  );
  assert.ok(result.refused instanceof AgentSessionError);
  assert.equal(result.switched.mode, 'fluidcast');
});

test('a hold lasts for its scope, and overlapping holds end independently', async () => {
  const { run } = makeWorld();
  const result = await run(
    Effect.gen(function* () {
      const agents = yield* AgentSessionService;
      const first = yield* Scope.make();
      const second = yield* Scope.make();
      yield* agents.holdWorktreesForDeletion([1]).pipe(Scope.provide(first));
      yield* agents.holdWorktreesForDeletion([1]).pipe(Scope.provide(second));
      const whileBoth = yield* Effect.flip(toFluidcast());
      // One delete fails and ends its hold; the other's still refuses.
      yield* Scope.close(first, Exit.fail('git failed'));
      const whileOne = yield* Effect.flip(toFluidcast());
      yield* Scope.close(second, Exit.void);
      return { whileBoth, whileOne, after: yield* toFluidcast() };
    }),
  );
  for (const refused of [result.whileBoth, result.whileOne]) {
    assert.ok(refused instanceof AgentSessionError);
    assert.equal(refused.code, 'session_deleting');
  }
  assert.equal(result.after.mode, 'fluidcast');
});

test('a worktree hold refuses every agent of that worktree, including one it never listed, and only those', async () => {
  const { run } = makeWorld({
    agents: [
      { id: 10, worktreeId: 1 },
      { id: 11, worktreeId: 1 },
      { id: 12, worktreeId: 2 },
    ],
  });
  const result = await run(
    Effect.gen(function* () {
      yield* (yield* AgentSessionService).holdWorktreesForDeletion([1]);
      return {
        held: yield* Effect.flip(toFluidcast(11)),
        other: yield* toFluidcast(12),
      };
    }),
  );
  assertDeleting(result.held);
  assert.equal(result.other.mode, 'fluidcast');
});

function assertDeleting(error: unknown) {
  assert.ok(error instanceof AgentSessionError);
  assert.equal(error.code, 'session_deleting');
}

test('a project hold refuses every agent of every worktree in that project, and only those', async () => {
  const { run } = makeWorld({
    agents: [
      { id: 10, worktreeId: 1 },
      { id: 11, worktreeId: 2 },
      { id: 12, worktreeId: 3 },
    ],
  });
  const result = await run(
    Effect.gen(function* () {
      const interaction = yield* AgentSessionInteraction;
      // Project 101 owns worktree 1, project 102 worktree 2: hold 101 and 102.
      yield* (yield* AgentSessionService).holdProjectForDeletion(101);
      yield* interaction.holdForDeletion([{ projectId: 102 }]);
      return {
        first: yield* Effect.flip(toFluidcast(10)),
        second: yield* Effect.flip(toFluidcast(11)),
        other: yield* toFluidcast(12),
      };
    }),
  );
  assertDeleting(result.first);
  assertDeleting(result.second);
  assert.equal(result.other.mode, 'fluidcast');
});
