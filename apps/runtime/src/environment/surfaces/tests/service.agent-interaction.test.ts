import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { Deferred, Effect, Fiber, type Layer } from 'effect';

import type { AgentSessionMetadata } from '@isagi/contracts';

import type { FluidcastAvailability } from '../../../fluidcast/index.js';
import {
  makeFakeFluidcastSessions,
  type FakeFluidcastSessions,
} from '../../../fluidcast/testing.js';
import { tapInternalEvents } from '../../../platform/events/testing.js';
import { RuntimeDatabase } from '../../../platform/persistence/index.js';
import { AgentSessionAttentionProjection } from '../../agent-sessions/attention.js';
import { AgentSessionInteraction } from '../../agent-sessions/interaction.js';
import { SurfaceService } from '../../index.js';
import { agentSessions } from '../../tables.js';
import {
  addPaneToSurface,
  insertAgentSessionForWorktree,
  insertPtyProcess,
  insertWorktree,
  testLayer,
} from '../../testing.js';

// The pane DTO's interaction and status under each controller, read through the same sources the
// rail's attention uses, and the delete paths' release of whatever controller is current.

function withSurfaces<A, E>(
  options: Parameters<typeof testLayer>[1] & { readonly fluidcast?: FakeFluidcastSessions },
  body: Effect.Effect<A, E, Layer.Success<ReturnType<typeof testLayer>>>,
) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-agent-interaction-'));
  return Effect.runPromise(body.pipe(Effect.provide(testLayer(dataRoot, options)))).finally(() =>
    rmSync(dataRoot, { recursive: true, force: true }),
  );
}

/** One surface with one agent pane of `harness`. */
const agentPane = (harness: AgentSessionMetadata['harness']) =>
  Effect.gen(function* () {
    const worktreeId = yield* insertWorktree('/repo/isagi');
    const surfaces = yield* SurfaceService;
    const surface = yield* surfaces.createSinglePaneSurface({ worktreeId, titleBase: 'Agent' });
    const agentSessionId = yield* insertAgentSessionForWorktree({
      worktreeId,
      paneId: surface.paneId,
      harness,
    });
    return { worktreeId, surfaceId: surface.surfaceId, paneId: surface.paneId, agentSessionId };
  });

const paneAgent = (surfaceId: number) =>
  Effect.gen(function* () {
    const detail = yield* (yield* SurfaceService).getSurfaceDetail(surfaceId);
    const session = detail.panes[0]?.session;
    assert.equal(session?.kind, 'agent_session');
    return session.agentSession;
  });

test('a terminal-mode pane offers Fluidcast only for an SDK harness with Fluidcast ready', async () => {
  const cases: ReadonlyArray<
    readonly [AgentSessionMetadata['harness'], FluidcastAvailability, 'available' | 'unavailable']
  > = [
    ['claude', 'ready', 'available'],
    ['codex', 'ready', 'available'],
    ['pi', 'ready', 'unavailable'],
    ['claude', 'disabled', 'unavailable'],
    ['claude', 'invalid', 'unavailable'],
  ];
  for (const [harness, availability, expected] of cases) {
    const agent = await withSurfaces(
      { fluidcast: makeFakeFluidcastSessions({ availability }) },
      Effect.flatMap(agentPane(harness), ({ surfaceId }) => paneAgent(surfaceId)),
    );
    assert.deepEqual(
      agent.interaction,
      { mode: 'terminal', generation: 0, fluidcast: expected },
      harness,
    );
  }
});

test('a Fluidcast-mode pane reports its session, and its status and rail attention agree', async () => {
  const fluidcast = makeFakeFluidcastSessions();
  const result = await withSurfaces(
    { fluidcast },
    Effect.gen(function* () {
      const { surfaceId, agentSessionId } = yield* agentPane('claude');
      const interaction = yield* AgentSessionInteraction;
      const attention = yield* AgentSessionAttentionProjection;
      const railFor = Effect.map(
        attention.listAttentionSources,
        (sources) => sources.find((source) => source.source.id === agentSessionId)?.attention,
      );

      const terminal = yield* paneAgent(surfaceId);
      const started = yield* fluidcast.service.start({
        agentSessionId,
        harness: 'claude',
        cwd: '/repo/isagi',
        harnessSessionId: null,
      });
      interaction.setFluidcast(agentSessionId, started);
      const live = yield* paneAgent(surfaceId);
      const liveRail = yield* railFor;
      const liveCount = yield* attention.workingAgentCount;

      fluidcast.fault(started.fluidcastSessionId, 'worker_exited');
      const ended = yield* paneAgent(surfaceId);
      const endedRail = yield* railFor;
      return { terminal, live, liveRail, liveCount, ended, endedRail };
    }),
  );
  // Never launched: the terminal pane is starting.
  assert.equal(result.terminal.status, 'starting');
  assert.deepEqual(result.live.interaction, {
    mode: 'fluidcast',
    generation: 1,
    fluidcastSessionId: 'fc-1',
  });
  assert.equal(result.live.status, 'running');
  assert.equal(result.live.statusReason, null);
  // Running with no harness activity yet: idle, and not counted as working.
  assert.equal(result.liveRail, 'idle');
  assert.equal(result.liveCount, 0);
  assert.equal(result.ended.status, 'failed');
  assert.equal(result.ended.statusReason, 'agent_worker_failed');
  assert.equal(result.ended.diagnosticDetail, 'worker_exited');
  assert.equal(result.endedRail, 'error');
});

test('a failed switch projects its failure and generation, offers no terminal, and reads its PTY row', async () => {
  const fluidcast = makeFakeFluidcastSessions();
  const result = await withSurfaces(
    { fluidcast },
    Effect.gen(function* () {
      const { worktreeId, surfaceId, agentSessionId } = yield* agentPane('claude');
      const interaction = yield* AgentSessionInteraction;
      const surfaces = yield* SurfaceService;
      // The terminal whose stop failed is still running and still the agent's pointer.
      const host = yield* surfaces.createSinglePaneSurface({ worktreeId, titleBase: 'Host' });
      const pty = yield* insertPtyProcess({
        paneId: host.paneId,
        worktreeId,
        logPath: null,
        status: 'running',
      });
      yield* (yield* RuntimeDatabase).use('test_point_agent_at_live_pty', (db) =>
        db
          .update(agentSessions)
          .set({ activePtyProcessId: pty.ptyProcessId })
          .where(eq(agentSessions.id, agentSessionId))
          .run(),
      );
      const started = yield* fluidcast.service.start({
        agentSessionId,
        harness: 'claude',
        cwd: '/repo/isagi',
        harnessSessionId: null,
      });
      interaction.setFluidcast(agentSessionId, started);
      interaction.setTerminal(agentSessionId);
      interaction.setFailed(agentSessionId, {
        code: 'terminal_stop_failed',
        diagnostic: 'PTY kill error',
      });
      const failed = yield* paneAgent(surfaceId);
      interaction.setTerminal(agentSessionId);
      const back = yield* paneAgent(surfaceId);
      return { failed, back, pty };
    }),
  );
  assert.deepEqual(result.failed.interaction, {
    mode: 'fluidcast_failed',
    generation: 3,
    failure: { code: 'terminal_stop_failed', diagnostic: 'PTY kill error' },
  });
  assert.equal(result.failed.processIncarnation, null);
  assert.equal(result.failed.status, 'running');
  assert.deepEqual(result.back.interaction, {
    mode: 'terminal',
    generation: 4,
    fluidcast: 'available',
  });
  assert.equal(result.back.processIncarnation, `pty:${result.pty.ptyProcessId}`);
});

test('a pane carries the incarnation of its live terminal process, and none without one', async () => {
  const fluidcast = makeFakeFluidcastSessions();
  const result = await withSurfaces(
    { fluidcast },
    Effect.gen(function* () {
      const { worktreeId, surfaceId, agentSessionId } = yield* agentPane('claude');
      const surfaces = yield* SurfaceService;
      const neverLaunched = yield* paneAgent(surfaceId);

      // Two live PTYs (the helper binds each to a terminal pane); the agent is then pointed at the
      // second, which is all its projection reads.
      const shellSurface = yield* surfaces.createSinglePaneSurface({
        worktreeId,
        titleBase: 'Shell',
      });
      const shell = yield* insertPtyProcess({
        paneId: shellSurface.paneId,
        worktreeId,
        logPath: null,
        status: 'running',
      });
      const agentPty = yield* insertPtyProcess({
        paneId: yield* addPaneToSurface(shellSurface.surfaceId),
        worktreeId,
        logPath: null,
        status: 'running',
      });
      yield* (yield* RuntimeDatabase).use('test_point_agent_at_live_pty', (db) =>
        db
          .update(agentSessions)
          .set({ activePtyProcessId: agentPty.ptyProcessId })
          .where(eq(agentSessions.id, agentSessionId))
          .run(),
      );
      const terminalMode = yield* paneAgent(surfaceId);
      const shellDetail = yield* surfaces.getSurfaceDetail(shellSurface.surfaceId);

      const exitedSurface = yield* surfaces.createSinglePaneSurface({
        worktreeId,
        titleBase: 'Done',
      });
      yield* insertPtyProcess({
        paneId: exitedSurface.paneId,
        worktreeId,
        logPath: null,
        status: 'exited',
      });
      const exitedDetail = yield* surfaces.getSurfaceDetail(exitedSurface.surfaceId);

      const started = yield* fluidcast.service.start({
        agentSessionId,
        harness: 'claude',
        cwd: '/repo/isagi',
        harnessSessionId: null,
      });
      (yield* AgentSessionInteraction).setFluidcast(agentSessionId, started);
      const fluidcastMode = yield* paneAgent(surfaceId);
      return {
        neverLaunched,
        terminalMode,
        fluidcastMode,
        shell,
        agentPty,
        shellDetail,
        exitedDetail,
      };
    }),
  );
  const terminalOf = (detail: typeof result.shellDetail) => {
    const session = detail.panes[0]?.session;
    assert.equal(session?.kind, 'terminal_session');
    return session.terminalSession;
  };
  assert.equal(result.neverLaunched.processIncarnation, null);
  assert.equal(result.terminalMode.processIncarnation, `pty:${result.agentPty.ptyProcessId}`);
  // The worker streams no terminal, whatever the persisted pointer still names.
  assert.equal(result.fluidcastMode.processIncarnation, null);
  assert.equal(
    terminalOf(result.shellDetail).processIncarnation,
    `pty:${result.shell.ptyProcessId}`,
  );
  assert.equal(terminalOf(result.exitedDetail).processIncarnation, null);
});

test('pane and surface delete release the deleted agents before terminating their PTYs', async () => {
  for (const target of ['pane', 'surface'] as const) {
    const log: string[] = [];
    const deleted = await withSurfaces(
      {
        agentService: {
          releaseControllers: (ids) =>
            Effect.sync(() => void log.push(`release:${[...ids].join(',')}`)),
        },
        ptyService: {
          terminateMany: (input) =>
            Effect.sync(() => {
              log.push(`terminate:${input.ptyProcessIds.length}`);
              return { terminated: [], alreadyAbsent: [], failed: [] } as never;
            }),
        },
      },
      Effect.gen(function* () {
        const { surfaceId, paneId, worktreeId, agentSessionId } = yield* agentPane('claude');
        const surfaces = yield* SurfaceService;
        if (target === 'pane') {
          // A second pane keeps the surface, so only the agent's pane goes.
          yield* addPaneToSurface(surfaceId);
          yield* surfaces.deleteSurfacePane({ surfaceId, paneId });
        } else {
          yield* surfaces.deleteSurface(surfaceId);
        }
        return { agentSessionId, worktreeId };
      }),
    );
    assert.deepEqual(log, [`release:${deleted.agentSessionId}`, 'terminate:0'], target);
  }
});

test('a delete interrupted after its commit has still released the deleted agents', async () => {
  for (const target of ['pane', 'surface'] as const) {
    const released: number[][] = [];
    const reading = Effect.runSync(Deferred.make<void>());
    const outcome = await withSurfaces(
      {
        agentService: {
          releaseControllers: (ids) => Effect.sync(() => void released.push([...ids])),
        },
        // The post-commit read of the deleted panes' sessions never answers, so the caller is
        // interrupted while it waits: a client disconnect after the rows are gone.
        decorateSurfaceRepository: (inner) => ({
          ...inner,
          listSessionsBoundTo: () =>
            Effect.andThen(Deferred.succeed(reading, undefined), Effect.never),
        }),
      },
      Effect.gen(function* () {
        const { surfaceId, paneId, agentSessionId } = yield* agentPane('claude');
        const surfaces = yield* SurfaceService;
        if (target === 'pane') yield* addPaneToSurface(surfaceId);
        const deleting = yield* Effect.forkChild(
          target === 'pane'
            ? surfaces.deleteSurfacePane({ surfaceId, paneId })
            : surfaces.deleteSurface(surfaceId),
        );
        yield* Deferred.await(reading);
        yield* Fiber.interrupt(deleting);
        return { agentSessionId };
      }),
    );
    assert.deepEqual(released, [[outcome.agentSessionId]], target);
  }
});

test('a delete interrupted while it releases controllers still finishes the release and publishes the deletion', async () => {
  for (const target of ['pane', 'surface'] as const) {
    const releasing = Effect.runSync(Deferred.make<void>());
    const proceed = Effect.runSync(Deferred.make<void>());
    const released: number[][] = [];
    const outcome = await withSurfaces(
      {
        agentService: {
          // A slow release: a Fluidcast stop, or a lock held by a switch.
          releaseControllers: (ids) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(releasing, undefined);
              yield* Deferred.await(proceed);
              released.push([...ids]);
            }),
        },
      },
      Effect.scoped(
        Effect.gen(function* () {
          const { surfaceId, paneId, agentSessionId } = yield* agentPane('claude');
          const surfaces = yield* SurfaceService;
          if (target === 'pane') yield* addPaneToSurface(surfaceId);
          const changes = yield* tapInternalEvents(['surface_changed']);
          const deleting = yield* Effect.forkChild(
            target === 'pane'
              ? surfaces.deleteSurfacePane({ surfaceId, paneId })
              : surfaces.deleteSurface(surfaceId),
          );
          yield* Deferred.await(releasing);
          // The client goes away while the release is blocked.
          const interrupting = yield* Effect.forkChild(Fiber.interrupt(deleting));
          // Let the interrupt reach the delete fiber while its release is still blocked.
          yield* Effect.sleep('20 millis');
          yield* Deferred.succeed(proceed, undefined);
          yield* Fiber.join(interrupting);
          const changed = yield* changes.take.pipe(Effect.timeout('2 seconds'));
          return { surfaceId, paneId, agentSessionId, changed };
        }),
      ),
    );
    assert.deepEqual(released, [[outcome.agentSessionId]], target);
    assert.equal(outcome.changed.payload.surfaceId, outcome.surfaceId, target);
    assert.equal(outcome.changed.payload.change, target === 'pane' ? 'pane_deleted' : 'deleted');
    assert.deepEqual(outcome.changed.payload.deletedPaneIds.includes(outcome.paneId), true);
  }
});
