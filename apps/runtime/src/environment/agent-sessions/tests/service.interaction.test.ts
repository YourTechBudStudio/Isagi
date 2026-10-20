import assert from 'node:assert/strict';
import test from 'node:test';

import { Cause, Deferred, Effect, Fiber, Layer, Scope, Exit } from 'effect';

import type { AgentSessionInteractionOrigin } from '@isagi/contracts';

import { makeLogCapture } from '../../../../test/test-support.js';
import {
  FluidcastSessions,
  FluidcastSessionUnreadable,
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
import { DatabaseError } from '../../../platform/persistence/index.js';
import { PtyKillError, PtyService, type PtyProcessRow } from '../../../pty-processes/index.js';
import { fakeTerminateMany } from '../../../pty-processes/testing.js';
import { SessionLifecycle } from '../../sessions/lifecycle.js';
import { sessionProcessIncarnation } from '../../sessions/status.js';
import type { AgentSessionRow } from '../../sessions/types.js';
import { AgentSessionInteraction } from '../interaction.js';
import { AgentSessionRepository } from '../repository.js';
import { AgentSessionError, AgentSessionService, AgentTerminalStopFailed } from '../service.js';

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
  /** Every repository read after the first terminate fails, as a database fault mid-handoff. */
  readonly readsFailAfterTerminate?: boolean;
  /** The native ID the terminal persists while it stops, as a harness hook can. */
  readonly nativeIdPersistedOnStop?: string;
}

/** Faults a test turns on and off while the world runs. */
interface Faults {
  /** `pty.terminate` reports an error and leaves the process running. */
  terminateFails: boolean;
  readsFail: boolean;
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
  const faults: Faults = { terminateFails: false, readsFail: false };
  let nextPty = 100;

  const setPtyStatus = (ptyProcessId: number, status: PtyProcessRow['status']) => {
    for (const [id, row] of world.rows)
      if (row.activePtyProcessId === ptyProcessId && row.activePtyProcess)
        world.rows.set(id, { ...row, activePtyProcess: { ...row.activePtyProcess, status } });
  };

  const terminate: PtyService['Service']['terminate'] = (input) =>
    Effect.suspend(() => {
      log.push(`pty.terminate:${input.ptyProcessId}`);
      if (faults.terminateFails)
        return Effect.fail(
          new PtyKillError({ ptyProcessId: input.ptyProcessId, cause: new Error('EPERM') }),
        );
      setPtyStatus(input.ptyProcessId, 'killed');
      if (options.nativeIdPersistedOnStop !== undefined)
        for (const [id, row] of world.rows)
          if (row.activePtyProcessId === input.ptyProcessId)
            world.rows.set(id, { ...row, harnessSessionId: options.nativeIdPersistedOnStop });
      if (options.readsFailAfterTerminate) faults.readsFail = true;
      return Effect.succeed('terminated_live' as const);
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
    find: (id) =>
      faults.readsFail
        ? Effect.fail(new DatabaseError({ operation: 'find_agent_session', cause: null }))
        : Effect.sync(() => world.rows.get(id) ?? null),
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
    faults,
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

/**
 * The `from` a client would send for the agent as it is now, by the client's rule: the
 * interaction's generation, its Fluidcast session only in `fluidcast` mode, and the incarnation the
 * projection shows.
 */
const originOf = (agentSessionId = 10) =>
  Effect.gen(function* () {
    const control = (yield* AgentSessionInteraction).control(agentSessionId);
    const row = yield* (yield* AgentSessionService).get(agentSessionId);
    return {
      generation: control.generation,
      fluidcastSessionId: control.mode === 'fluidcast' ? control.fluidcastSessionId : null,
      processIncarnation: sessionProcessIncarnation(row, control),
    } satisfies AgentSessionInteractionOrigin;
  }).pipe(Effect.orDie);

/** A switch made from the agent's current state, or from `from` when given. */
const switchTo =
  (mode: 'terminal' | 'fluidcast') =>
  (agentSessionId = 10, from?: AgentSessionInteractionOrigin) =>
    Effect.gen(function* () {
      const origin = from ?? (yield* originOf(agentSessionId));
      return yield* (yield* AgentSessionService).setInteractionMode({
        agentSessionId,
        mode,
        from: origin,
      });
    });
const toFluidcast = switchTo('fluidcast');
const toTerminal = switchTo('terminal');
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
  assert.deepEqual(result.interaction, {
    mode: 'fluidcast',
    generation: 1,
    fluidcastSessionId: 'fc-1',
  });
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

test('each failed start records its reason, with the terminal stopped and a null interval', async () => {
  for (const reason of [
    'executable_not_found',
    'instrumentation_failed',
    'session_build_failed',
  ] as const) {
    const fluidcast = makeFakeFluidcastSessions({
      onStart: () => Effect.fail(new FluidcastStartFailed({ reason })),
    });
    const { world, run } = makeWorld({ fluidcast });
    const result = await run(
      Effect.gen(function* () {
        const error = yield* Effect.flip(toFluidcast());
        return { error, interaction: (yield* AgentSessionInteraction).get(10) };
      }),
    );
    assert.ok(result.error instanceof FluidcastStartFailed, reason);
    assert.deepEqual(result.interaction, {
      mode: 'fluidcast_failed',
      generation: 1,
      failure: { code: 'fluidcast_start_failed', reason },
    });
    assert.equal(world.rows.get(10)?.activePtyProcess?.status, 'killed', reason);
    assert.deepEqual(switches(world.events), [null], reason);
    assert.equal(changedCount(world.events), 1, reason);
  }
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
  assert.deepEqual(result.interaction, {
    mode: 'fluidcast_failed',
    generation: 1,
    failure: { code: 'fluidcast_start_failed', reason: 'session_build_failed' },
  });
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
  assert.deepEqual(result.interaction, { mode: 'terminal', generation: 2 });
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
      // Made from the state the first switch produces, so it is current once it holds the lock.
      const second = yield* Effect.forkChild(
        toTerminal(10, { generation: 1, fluidcastSessionId: 'fc-1', processIncarnation: null }),
      );
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
  assert.deepEqual(interaction, { mode: 'fluidcast', generation: 1, fluidcastSessionId: 'fc-1' });
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
  assert.deepEqual(interaction, { mode: 'terminal', generation: 2 });
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
  assert.deepEqual(after.interaction, { mode: 'terminal', generation: 2 });
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

// ── Failed handoffs, Retry and Back to terminal ──────────────────────────────

/** A Fluidcast fake whose first `count` starts fail with `failure`, then succeed. */
function failingStarts(
  failure: FluidcastSessionUnreadable | FluidcastStartFailed | (() => never),
  count = 1,
  log?: string[],
) {
  let remaining = count;
  return makeFakeFluidcastSessions({
    ...(log === undefined ? {} : { log }),
    onStart: () => {
      if (remaining === 0) return Effect.void;
      remaining -= 1;
      return typeof failure === 'function' ? Effect.sync(failure) : Effect.fail(failure);
    },
  });
}

const interactionOf = (agentSessionId = 10) =>
  Effect.map(AgentSessionInteraction, (interaction) => interaction.get(agentSessionId));

test('an unreadable session records its reason and the start received the native ID persisted while stopping', async () => {
  const fluidcast = failingStarts(new FluidcastSessionUnreadable({ reason: 'SessionNotFound' }));
  const { world, run } = makeWorld({
    fluidcast,
    agents: [{ id: 10, harnessSessionId: null }],
    nativeIdPersistedOnStop: 'persisted-while-stopping',
  });
  const result = await run(
    Effect.gen(function* () {
      const error = yield* Effect.flip(toFluidcast());
      return { error, interaction: yield* interactionOf() };
    }),
  );
  assert.ok(result.error instanceof FluidcastSessionUnreadable);
  assert.deepEqual(result.interaction, {
    mode: 'fluidcast_failed',
    generation: 1,
    failure: { code: 'fluidcast_session_unreadable', reason: 'SessionNotFound' },
  });
  const start = fluidcast.calls.find((call) => call.kind === 'start');
  assert.equal(start?.kind === 'start' && start.input.harnessSessionId, 'persisted-while-stopping');
  assert.deepEqual(switches(world.events), [null]);
  assert.equal(changedCount(world.events), 1);
});

test('a database failure after the stop records fluidcast_preparation_failed, not terminal mode', async () => {
  const { world, run } = makeWorld({ readsFailAfterTerminate: true });
  const logs = makeLogCapture();
  const result = await run(
    Effect.gen(function* () {
      const error = yield* Effect.flip(toFluidcast());
      return { error, interaction: yield* interactionOf() };
    }).pipe(Effect.provide(logs.layer)),
  );
  assert.ok(result.error instanceof DatabaseError);
  assert.deepEqual(result.interaction, {
    mode: 'fluidcast_failed',
    generation: 1,
    failure: {
      code: 'fluidcast_preparation_failed',
      diagnostic: 'Database operation find_agent_session failed',
    },
  });
  assert.deepEqual(world.log, ['pty.terminate:30']);
  assert.deepEqual(switches(world.events), [null]);
  const warning = logs.lines.find(
    (line) => line.message === 'agent session fluidcast handoff failed',
  );
  assert.equal(warning?.annotations.agentSessionId, 10);
  assert.equal(warning?.annotations.generation, 1);
  assert.equal(warning?.annotations.code, 'fluidcast_preparation_failed');
});

test('a defect after the stop is recorded and still propagates as a defect', async () => {
  const fluidcast = failingStarts(() => {
    throw new Error('worker exploded with a secret in its message');
  });
  const { world, run } = makeWorld({ fluidcast });
  const result = await run(
    Effect.gen(function* () {
      const exit = yield* Effect.exit(toFluidcast());
      return { exit, interaction: yield* interactionOf() };
    }),
  );
  assert.ok(Exit.isFailure(result.exit) && Cause.hasDies(result.exit.cause));
  assert.deepEqual(result.interaction, {
    mode: 'fluidcast_failed',
    generation: 1,
    failure: { code: 'fluidcast_preparation_failed', diagnostic: 'Error' },
  });
  assert.deepEqual(switches(world.events), [null]);
});

test('a terminal stop that reports an error blocks Fluidcast and publishes no null interval', async () => {
  const { world, fluidcast, faults, run } = makeWorld();
  faults.terminateFails = true;
  const result = await run(
    Effect.gen(function* () {
      const error = yield* Effect.flip(toFluidcast());
      return { error, interaction: yield* interactionOf() };
    }),
  );
  assert.ok(result.error instanceof AgentTerminalStopFailed);
  assert.equal(result.error.ptyProcessId, 30);
  assert.deepEqual(result.interaction, {
    mode: 'fluidcast_failed',
    generation: 1,
    failure: {
      code: 'terminal_stop_failed',
      diagnostic: 'PTY kill error (ptyProcess=30): Error',
    },
  });
  assert.deepEqual(fluidcast.calls, []);
  assert.equal(world.rows.get(10)?.activePtyProcess?.status, 'running');
  // Nothing ended: the terminal's own interval stays open.
  assert.deepEqual(switches(world.events), []);
  assert.equal(changedCount(world.events), 1);
});

test('Retry from a failed state starts Fluidcast without stopping the stopped terminal again', async () => {
  const fluidcast = failingStarts(new FluidcastStartFailed({ reason: 'executable_not_found' }));
  const { world, run } = makeWorld({ fluidcast });
  const result = await run(
    Effect.gen(function* () {
      yield* Effect.flip(toFluidcast());
      return { retried: yield* toFluidcast(), interaction: yield* interactionOf() };
    }),
  );
  assert.equal(result.retried.mode, 'fluidcast');
  assert.deepEqual(result.interaction, {
    mode: 'fluidcast',
    generation: 2,
    fluidcastSessionId: result.retried.fluidcastSessionId,
  });
  assert.deepEqual(world.log, ['pty.terminate:30']);
  assert.deepEqual(switches(world.events), [null, `sdk:${result.retried.fluidcastSessionId}`]);
});

test('a failing Retry replaces the record and raises the generation', async () => {
  let attempt = 0;
  const fluidcast = makeFakeFluidcastSessions({
    onStart: () =>
      Effect.fail(
        attempt++ === 0
          ? new FluidcastSessionUnreadable({ reason: 'SessionUnreadable' })
          : new FluidcastStartFailed({ reason: 'instrumentation_failed' }),
      ),
  });
  const { run } = makeWorld({ fluidcast });
  const interaction = await run(
    Effect.gen(function* () {
      yield* Effect.flip(toFluidcast());
      yield* Effect.flip(toFluidcast());
      return yield* interactionOf();
    }),
  );
  assert.deepEqual(interaction, {
    mode: 'fluidcast_failed',
    generation: 2,
    failure: { code: 'fluidcast_start_failed', reason: 'instrumentation_failed' },
  });
});

test('Retry after a stop failure stops the terminal, then starts', async () => {
  const { world, faults, run } = makeWorld();
  faults.terminateFails = true;
  const result = await run(
    Effect.gen(function* () {
      yield* Effect.flip(toFluidcast());
      faults.terminateFails = false;
      return yield* toFluidcast();
    }),
  );
  assert.equal(result.mode, 'fluidcast');
  assert.deepEqual(world.log, ['pty.terminate:30', 'pty.terminate:30', 'fluidcast.start:10']);
  assert.deepEqual(switches(world.events), ['sdk:fc-1']);
});

test('Back to terminal resumes the stored native session, or launches fresh without one', async () => {
  for (const harnessSessionId of ['claude-session', null]) {
    const fluidcast = failingStarts(new FluidcastStartFailed({ reason: 'session_build_failed' }));
    const { world, run } = makeWorld({ fluidcast, agents: [{ id: 10, harnessSessionId }] });
    const result = await run(
      Effect.gen(function* () {
        yield* Effect.flip(toFluidcast());
        return { back: yield* toTerminal(), interaction: yield* interactionOf() };
      }),
    );
    assert.deepEqual(result.back, { mode: 'terminal', fluidcastSessionId: null });
    assert.deepEqual(result.interaction, { mode: 'terminal', generation: 2 });
    assert.deepEqual(world.launches, [{ agentSessionId: 10, resume: harnessSessionId }]);
    assert.deepEqual(switches(world.events), [null, 'pty:100']);
    // One change for the failure, one for Back.
    assert.equal(changedCount(world.events), 2);
  }
});

test('Back to terminal whose launch fails stays in terminal mode and returns the error', async () => {
  const fluidcast = failingStarts(new FluidcastStartFailed({ reason: 'executable_not_found' }));
  const { world, run } = makeWorld({ fluidcast });
  const result = await run(
    Effect.gen(function* () {
      yield* Effect.flip(toFluidcast());
      world.rows.set(10, { ...world.rows.get(10)!, harnessMetadataStatus: 'invalid' });
      const error = yield* Effect.flip(toTerminal());
      return { error, interaction: yield* interactionOf() };
    }),
  );
  assert.ok(result.error instanceof AgentSessionError);
  assert.equal(result.error.code, 'harness_metadata_invalid');
  assert.deepEqual(result.interaction, { mode: 'terminal', generation: 2 });
  assert.deepEqual(world.launches, []);
  assert.deepEqual(switches(world.events), [null]);
  assert.equal(changedCount(world.events), 2);
});

test('Back to terminal after a stop failure keeps the running terminal and launches nothing', async () => {
  const { world, faults, run } = makeWorld();
  faults.terminateFails = true;
  const result = await run(
    Effect.gen(function* () {
      yield* Effect.flip(toFluidcast());
      return { back: yield* toTerminal(), interaction: yield* interactionOf() };
    }),
  );
  assert.deepEqual(result.back, { mode: 'terminal', fluidcastSessionId: null });
  assert.deepEqual(result.interaction, { mode: 'terminal', generation: 2 });
  assert.deepEqual(world.log, ['pty.terminate:30']);
  assert.deepEqual(switches(world.events), []);
  assert.equal(changedCount(world.events), 2);
});

test('an admission refusal from a failed state leaves the record and its generation', async () => {
  const fluidcast = failingStarts(new FluidcastStartFailed({ reason: 'executable_not_found' }));
  const { world, run } = makeWorld({ fluidcast });
  const result = await run(
    Effect.gen(function* () {
      yield* Effect.flip(toFluidcast());
      const before = yield* interactionOf();
      world.placements.set(10, null);
      const retry = yield* Effect.flip(toFluidcast());
      const back = yield* Effect.flip(toTerminal());
      return { before, retry, back, after: yield* interactionOf() };
    }),
  );
  for (const refused of [result.retry, result.back]) {
    assert.ok(refused instanceof AgentSessionError);
    assert.equal(refused.code, 'session_not_placed');
  }
  assert.deepEqual(result.after, result.before);
  assert.deepEqual(world.log, ['pty.terminate:30']);
});

test('a switch from a controller that is no longer current is refused and changes nothing', async () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    /** A fresh world's options for each direction. */
    readonly options?: () => WorldOptions;
    /** Reaches the state the stale origin was captured in, and returns it. */
    readonly setup: Effect.Effect<
      AgentSessionInteractionOrigin,
      unknown,
      AgentSessionService | AgentSessionInteraction
    >;
  }> = [
    {
      name: 'an earlier generation',
      setup: Effect.gen(function* () {
        const stale = yield* originOf();
        yield* toFluidcast();
        yield* toTerminal();
        const current = yield* originOf();
        // Only the generation is stale: the relaunched terminal's incarnation is current.
        return { ...current, generation: stale.generation };
      }),
    },
    {
      name: 'a stopped Fluidcast instance',
      setup: Effect.gen(function* () {
        yield* toFluidcast();
        const stale = yield* originOf();
        yield* toTerminal();
        yield* toFluidcast();
        const current = yield* originOf();
        return { ...current, fluidcastSessionId: stale.fluidcastSessionId };
      }),
    },
    {
      name: 'an old terminal incarnation',
      options: () => ({
        agents: [{ id: 10, activePtyProcessId: 30, activePtyProcess: ptyRow(30, 'exited') }],
      }),
      setup: Effect.gen(function* () {
        // Captured before the pane's own relaunch, which keeps the generation.
        const stale = yield* originOf();
        yield* toTerminal();
        return stale;
      }),
    },
    {
      name: 'a previous failure',
      options: () => ({
        fluidcast: failingStarts(new FluidcastStartFailed({ reason: 'executable_not_found' }), 2),
      }),
      setup: Effect.gen(function* () {
        yield* Effect.flip(toFluidcast());
        const stale = yield* originOf();
        yield* Effect.flip(toFluidcast());
        return stale;
      }),
    },
  ];
  for (const testCase of cases) {
    for (const mode of ['fluidcast', 'terminal'] as const) {
      const { world, run } = makeWorld(testCase.options?.());
      const result = await run(
        Effect.gen(function* () {
          const stale = yield* testCase.setup;
          const before = yield* interactionOf();
          const log = [...world.log];
          const events = world.events.length;
          const error = yield* Effect.flip(switchTo(mode)(10, stale));
          return {
            error,
            before,
            after: yield* interactionOf(),
            unchangedLog: log.length === world.log.length,
            newEvents: world.events.length - events,
          };
        }),
      );
      const label = `${testCase.name} → ${mode}`;
      assert.ok(result.error instanceof AgentSessionError, label);
      assert.equal(result.error.code, 'interaction_changed', label);
      assert.deepEqual(result.after, result.before, label);
      assert.ok(result.unchangedLog, label);
      assert.equal(result.newEvents, 0, label);
    }
  }
});

test('release clears a failed record and publishes it ended', async () => {
  const fluidcast = failingStarts(new FluidcastStartFailed({ reason: 'executable_not_found' }));
  const { world, run } = makeWorld({ fluidcast });
  const interaction = await run(
    Effect.gen(function* () {
      yield* Effect.flip(toFluidcast());
      yield* release([10]);
      return yield* interactionOf();
    }),
  );
  assert.deepEqual(interaction, { mode: 'terminal', generation: 2 });
  assert.deepEqual(world.log, ['pty.terminate:30']);
  assert.deepEqual(switches(world.events), [null, null]);
});

// ── Terminal gates ───────────────────────────────────────────────────────────

const ensure = (
  options?: Parameters<AgentSessionService['Service']['ensureActivePtyProcess']>[1],
) => AgentSessionService.use((agents) => agents.ensureActivePtyProcess(10, options));

function assertRefusedWith(error: unknown, code: string, label: string) {
  assert.ok(error instanceof AgentSessionError, label);
  assert.equal(error.code, code, label);
}

test('ensuring a terminal is refused unless the agent is in terminal mode at the expected generation', async () => {
  // Fluidcast: the stopped terminal would be relaunched, or named by an expected incarnation.
  const underFluidcast = makeWorld();
  const fluidcastRefusals = await underFluidcast.run(
    Effect.gen(function* () {
      yield* toFluidcast();
      return {
        launch: yield* Effect.flip(ensure()),
        expected: yield* Effect.flip(ensure({ expectedIncarnation: 'pty:30' })),
      };
    }),
  );
  assertRefusedWith(fluidcastRefusals.launch, 'not_in_terminal_mode', 'fluidcast launch');
  assertRefusedWith(fluidcastRefusals.expected, 'not_in_terminal_mode', 'fluidcast expected');
  assert.match(
    (fluidcastRefusals.launch as AgentSessionError).message,
    /Fluidcast controls it\. Switch its pane back to the terminal, then retry\.$/,
  );
  assert.deepEqual(underFluidcast.world.launches, []);

  // A failed switch whose stop failed: the running terminal would be reused.
  const failed = makeWorld();
  failed.faults.terminateFails = true;
  const failedRefusals = await failed.run(
    Effect.gen(function* () {
      yield* Effect.flip(toFluidcast());
      return {
        reuse: yield* Effect.flip(ensure()),
        expected: yield* Effect.flip(ensure({ expectedIncarnation: 'pty:30' })),
        // The mode is checked first, whatever generation the token carries.
        stale: yield* Effect.flip(ensure({ controllerGeneration: 0 })),
      };
    }),
  );
  for (const [label, error] of Object.entries(failedRefusals))
    assertRefusedWith(error, 'not_in_terminal_mode', `failed ${label}`);
  assert.match(
    (failedRefusals.reuse as AgentSessionError).message,
    /its switch to Fluidcast failed\. Switch its pane back to the terminal, then retry\.$/,
  );
  assert.deepEqual(failed.world.launches, []);

  // Back in terminal mode at a newer generation: a token from the earlier one is refused.
  const roundTrip = makeWorld();
  const tokens = await roundTrip.run(
    Effect.gen(function* () {
      yield* toFluidcast();
      yield* toTerminal();
      return {
        stale: yield* Effect.flip(ensure({ controllerGeneration: 0 })),
        current: yield* ensure({ controllerGeneration: 2 }),
      };
    }),
  );
  assertRefusedWith(tokens.stale, 'interaction_changed', 'stale generation');
  assert.equal(tokens.current, 100);
});

test('a running-terminal write is refused after the controller changed, mode first', async () => {
  const { world, run } = makeWorld();
  const result = await run(
    Effect.gen(function* () {
      const agents = yield* AgentSessionService;
      const used: number[] = [];
      const use = (ptyProcessId: number) => Effect.sync(() => void used.push(ptyProcessId));
      yield* agents.withRunningTerminal(10, 0, use);
      yield* toFluidcast();
      const underFluidcast = yield* Effect.flip(agents.withRunningTerminal(10, 0, use));
      yield* toTerminal();
      const stale = yield* Effect.flip(agents.withRunningTerminal(10, 0, use));
      yield* agents.withRunningTerminal(10, 2, use);
      return { used, underFluidcast, stale };
    }),
  );
  assert.deepEqual(result.used, [30, 100]);
  assertRefusedWith(result.underFluidcast, 'not_in_terminal_mode', 'under Fluidcast');
  assertRefusedWith(result.stale, 'interaction_changed', 'stale generation');
  assert.deepEqual(world.log, [
    'pty.terminate:30',
    'fluidcast.start:10',
    'fluidcast.stop:fc-1',
    'pty.launch:100',
  ]);
});

test('a switch queued behind a running-terminal write runs only after the write', async () => {
  const held = Effect.runSync(Deferred.make<void>());
  const { world, run } = makeWorld();
  await run(
    Effect.gen(function* () {
      const agents = yield* AgentSessionService;
      const writing = yield* Effect.forkChild(
        agents.withRunningTerminal(10, 0, (ptyProcessId) =>
          Effect.gen(function* () {
            world.log.push(`write:start:${ptyProcessId}`);
            yield* Deferred.await(held);
            world.log.push(`write:end:${ptyProcessId}`);
          }),
        ),
      );
      yield* eventually(() => world.log.includes('write:start:30'));
      const switching = yield* Effect.forkChild(toFluidcast());
      yield* Effect.sleep('20 millis');
      assert.deepEqual(world.log, ['write:start:30']);
      yield* Deferred.succeed(held, undefined);
      yield* Fiber.join(writing);
      yield* Fiber.join(switching);
    }),
  );
  assert.deepEqual(world.log, [
    'write:start:30',
    'write:end:30',
    'pty.terminate:30',
    'fluidcast.start:10',
  ]);
});

test("the controller's liveness follows its mode", async () => {
  const live = (agentSessionId = 10) =>
    AgentSessionService.use((agents) => agents.isControllerLive(agentSessionId));

  const terminal = makeWorld({
    agents: [
      { id: 10 },
      { id: 11, activePtyProcessId: 31, activePtyProcess: ptyRow(31, 'exited') },
    ],
  });
  assert.deepEqual(await terminal.run(Effect.all([live(10), live(11)])), [true, false]);

  const fluidcast = makeWorld();
  const fluidcastLiveness = await fluidcast.run(
    Effect.gen(function* () {
      const switched = yield* toFluidcast();
      const whileLive = yield* live();
      fluidcast.fluidcast.fault(switched.fluidcastSessionId!, 'worker_exited');
      return { whileLive, afterFault: yield* live() };
    }),
  );
  assert.deepEqual(fluidcastLiveness, { whileLive: true, afterFault: false });

  // A failed switch reads its PTY row: running only when its stop failed.
  const stopFailed = makeWorld();
  stopFailed.faults.terminateFails = true;
  assert.equal(await stopFailed.run(Effect.andThen(Effect.flip(toFluidcast()), live())), true);
  const startFailed = makeWorld({
    fluidcast: failingStarts(new FluidcastStartFailed({ reason: 'executable_not_found' })),
  });
  assert.equal(await startFailed.run(Effect.andThen(Effect.flip(toFluidcast()), live())), false);
});

// ── Interaction state ────────────────────────────────────────────────────────

test('the generation rises exactly on record changes and never repeats', async () => {
  const { run } = makeWorld({ agents: [{ id: 10 }, { id: 11 }] });
  const result = await run(
    Effect.gen(function* () {
      const interaction = yield* AgentSessionInteraction;
      const seen: number[] = [interaction.get(10).generation];
      interaction.setTerminal(10);
      seen.push(interaction.get(10).generation);
      seen.push(
        interaction.setFluidcast(10, {
          fluidcastSessionId: 'fc-a' as never,
          since: '2026-10-01T00:00:00.000Z',
        }),
      );
      interaction.setTerminal(10);
      seen.push(interaction.get(10).generation);
      seen.push(
        interaction.setFailed(10, { code: 'fluidcast_preparation_failed', diagnostic: 'x' }),
      );
      seen.push(interaction.setFailed(10, { code: 'terminal_stop_failed', diagnostic: 'y' }));
      interaction.setTerminal(10);
      seen.push(interaction.get(10).generation);
      interaction.setFluidcast(11, {
        fluidcastSessionId: 'fc-b' as never,
        since: '2026-10-01T00:00:00.000Z',
      });
      return {
        seen,
        fluidcastAgents: interaction.fluidcastAgentIds(),
        other: interaction.get(11).generation,
      };
    }),
  );
  // A terminal-mode `setTerminal` changes nothing; every record change is a new value.
  assert.deepEqual(result.seen, [0, 0, 1, 2, 3, 4, 5]);
  assert.deepEqual(result.fluidcastAgents, [11]);
  assert.equal(result.other, 1);
});

test('a failed switch is not listed among the Fluidcast agents', async () => {
  const fluidcast = failingStarts(new FluidcastStartFailed({ reason: 'executable_not_found' }));
  const { run } = makeWorld({ fluidcast, agents: [{ id: 10 }, { id: 11 }] });
  const ids = await run(
    Effect.gen(function* () {
      yield* Effect.flip(toFluidcast(10));
      yield* toFluidcast(11);
      return (yield* AgentSessionInteraction).fluidcastAgentIds();
    }),
  );
  assert.deepEqual(ids, [11]);
});
