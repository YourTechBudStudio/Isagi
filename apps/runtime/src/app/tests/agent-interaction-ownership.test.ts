import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Context, Deferred, Effect, Fiber, Layer, Result } from 'effect';

import { CliEntry } from '../../cli-access/index.js';
import { AgentSessionAttentionProjection } from '../../environment/agent-sessions/attention.js';
import { AgentSessionInteraction } from '../../environment/agent-sessions/interaction.js';
import { AgentSessionError } from '../../environment/agent-sessions/service.js';
import {
  AgentSessionService,
  HarnessObservationTargetsLayer,
  SurfaceService,
} from '../../environment/index.js';
import { sessionProcessIncarnation } from '../../environment/sessions/status.js';
import {
  insertAgentSessionForWorktree,
  insertWorktree,
  sessionCreationLayerFor,
  sessionWorldLayers,
} from '../../environment/testing.js';
import type { FluidcastSessionId } from '../../fluidcast/index.js';
import { makeFakeFluidcastSessions } from '../../fluidcast/testing.js';
import { HarnessObservationTargets } from '../../harnesses/index.js';
import { Git, GitCommandError } from '../../platform/git/index.js';
import { DataDirectory, RuntimeDatabase } from '../../platform/persistence/index.js';
import { makeTestDataDirectory } from '../../platform/persistence/testing.js';
import { UserShell } from '../../platform/process/index.js';
import { ProjectRepository } from '../../projects/index.js';
import { RuntimeConfig } from '../../runtime-config/index.js';
import { WorkflowProjectErasure } from '../../workflows/index.js';
import { StateFile, WorkspaceService } from '../../workspace/index.js';
import {
  createGitProjectFixture,
  liveWorkspaceLayer,
  type LiveWorkspaceOptions,
} from '../../workspace/testing.js';
import { ModulesLayer } from '../layer.js';

/** The shim's target; the shim is written but never run here. */
const testCliEntry = Layer.succeed(CliEntry, { path: '/opt/isagi/isagi.mjs' });

/**
 * The ownership invariant across real modules: a mode switch creates a controller only for an
 * agent a pane holds and no delete holds. Tests 1–3 drive the real `AgentSessionService` and
 * interaction through the real worktree delete span and the real claim; the last builds the
 * production layers and checks every consumer reads the one interaction.
 */

type GitRun = Git['Service']['run'];

/**
 * One graph: the real session world (Fluidcast ready, faked) shared with the real workspace.
 * `removeWorktree` replaces git's `worktree remove`; `beforeCleanup` runs in command cleanup,
 * after the delete's first inventory and before its hold.
 */
function ownershipWorld(
  dataRoot: string,
  removeWorktree?: GitRun,
  beforeCleanup?: Effect.Effect<void>,
  fluidcastOptions?: Parameters<typeof makeFakeFluidcastSessions>[0],
) {
  const fluidcast = makeFakeFluidcastSessions(fluidcastOptions);
  const world = sessionWorldLayers(dataRoot, { ptyLaunches: [], harnessLaunches: [], fluidcast });
  const options: LiveWorkspaceOptions = {
    commands: {
      cleanupBeforeWorktreeDelete: () => beforeCleanup ?? Effect.void,
      runPostCreateLifecycle: () => Effect.void,
    },
    databaseLayer: world.database,
    agentSessionsLayer: world.agentService,
    decorateGit: (inner) => ({
      run: (args, runOptions) =>
        removeWorktree && args.includes('worktree') && args.includes('remove')
          ? removeWorktree(args, runOptions)
          : inner.run(args, runOptions),
    }),
  };
  return {
    fluidcast,
    layer: Layer.mergeAll(sessionCreationLayerFor(world), liveWorkspaceLayer(dataRoot, options)),
  };
}

/** A registered Git project with one Isagi-created worktree beside its root checkout. */
const projectWithWorktree = (rootPath: string) =>
  Effect.gen(function* () {
    const workspace = yield* WorkspaceService;
    const repository = yield* ProjectRepository;
    const { projectId } = yield* workspace.registerProject({ path: rootPath });
    const opened = yield* workspace.openWorktree({
      projectId,
      request: { branch: 'feature/agents', base: { kind: 'branch', ref: 'main' } },
    });
    assert.equal(opened.status, 'created');
    const worktree = (yield* repository.listWorktrees).find(
      (row) => row.projectId === projectId && row.path !== rootPath,
    );
    if (!worktree) throw new Error('Expected the Isagi-created worktree.');
    return { projectId, worktreeId: worktree.id };
  });

/** A new surface whose one pane holds a fresh Claude agent, created through `SurfaceService`. */
const placedAgent = (worktreeId: number) =>
  Effect.gen(function* () {
    const surfaces = yield* SurfaceService;
    const surface = yield* surfaces.createSinglePaneSurface({ worktreeId, titleBase: 'Agent' });
    const bound = yield* surfaces.createPaneSession({
      worktreeId,
      create: { kind: 'agent_session', paneId: surface.paneId, harness: 'claude' },
    });
    if (bound.session.kind !== 'agent_session') throw new Error('Expected an agent pane.');
    return {
      surfaceId: surface.surfaceId,
      paneId: surface.paneId,
      agentSessionId: bound.session.agentSessionId,
    };
  });

/** A switch made from the agent's current state, built by the client's rule for `from`. */
const switchTo = (agentSessionId: number, mode: 'terminal' | 'fluidcast') =>
  Effect.gen(function* () {
    const agents = yield* AgentSessionService;
    const control = (yield* AgentSessionInteraction).control(agentSessionId);
    const row = yield* agents.get(agentSessionId).pipe(Effect.orDie);
    return yield* agents.setInteractionMode({
      agentSessionId,
      mode,
      from: {
        generation: control.generation,
        fluidcastSessionId: control.mode === 'fluidcast' ? control.fluidcastSessionId : null,
        processIncarnation: sessionProcessIncarnation(row, control),
      },
    });
  });

function assertRefused(error: unknown, code: string) {
  assert.ok(error instanceof AgentSessionError, `expected an AgentSessionError, got ${error}`);
  assert.equal(error.code, code);
}

function withGitProject(
  label: string,
  body: (rootPath: string, dataRoot: string) => Promise<void>,
) {
  return async () => {
    const git = createGitProjectFixture(label);
    const dataRoot = mkdtempSync(join(tmpdir(), `isagi-${label}-`));
    try {
      await body(git.rootPath, dataRoot);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
      git.cleanup();
    }
  };
}

test(
  'a switch during a real worktree delete is refused while the delete holds its agents',
  withGitProject('ownership-delete-hold', async (rootPath, dataRoot) => {
    const reached = Effect.runSync(Deferred.make<void>());
    const proceed = Effect.runSync(Deferred.make<void>());
    // `worktree remove` runs inside the delete's hold span, after its release.
    const { fluidcast, layer } = ownershipWorld(dataRoot, (args, options) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(reached, undefined);
        yield* Deferred.await(proceed);
        return yield* Effect.flatMap(Git, (git) => git.run(args, options));
      }).pipe(Effect.provide(Git.layer)),
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { projectId, worktreeId } = yield* projectWithWorktree(rootPath);
        const agent = yield* placedAgent(worktreeId);
        yield* switchTo(agent.agentSessionId, 'fluidcast');

        const workspace = yield* WorkspaceService;
        const deleting = yield* Effect.forkChild(
          workspace.deleteWorktree({
            projectId,
            worktreeId,
            request: { checkoutRemovalMode: 'force', branchRemovalMode: 'preserve' },
          }),
        );
        yield* Deferred.await(reached);
        // The pane is still placed: only the hold refuses. Captured, not asserted yet: the
        // paused delete must be let go whatever happens here.
        const attempt = yield* Effect.result(switchTo(agent.agentSessionId, 'fluidcast'));
        const liveWhileHeld = fluidcast.live();
        yield* Deferred.succeed(proceed, undefined);
        const deleted = yield* Fiber.join(deleting);
        return { attempt, liveWhileHeld, deleted };
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );
    assert.ok(Result.isFailure(result.attempt), 'the held agent switched to Fluidcast');
    assertRefused(result.attempt.failure, 'session_deleting');
    // The delete stopped the hidden Fluidcast session before it removed the checkout.
    assert.deepEqual(result.liveWhileHeld, []);
    assert.equal(result.deleted.deletedWorktreeId > 0, true);
  }),
);

test(
  'an agent created while a worktree delete holds its worktree cannot switch, and nothing outlives the cascade',
  withGitProject('ownership-delete-late-agent', async (rootPath, dataRoot) => {
    const reached = Effect.runSync(Deferred.make<void>());
    const proceed = Effect.runSync(Deferred.make<void>());
    const { fluidcast, layer } = ownershipWorld(dataRoot, (args, options) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(reached, undefined);
        yield* Deferred.await(proceed);
        return yield* Effect.flatMap(Git, (git) => git.run(args, options));
      }).pipe(Effect.provide(Git.layer)),
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { projectId, worktreeId } = yield* projectWithWorktree(rootPath);
        const deleting = yield* Effect.forkChild(
          (yield* WorkspaceService).deleteWorktree({
            projectId,
            worktreeId,
            request: { checkoutRemovalMode: 'force', branchRemovalMode: 'preserve' },
          }),
        );
        yield* Deferred.await(reached);
        // Created and placed after the delete read its agents: no inventory names it.
        const late = yield* placedAgent(worktreeId);
        const attempt = yield* Effect.result(switchTo(late.agentSessionId, 'fluidcast'));
        yield* Deferred.succeed(proceed, undefined);
        yield* Fiber.join(deleting);
        return { attempt };
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );
    assert.ok(Result.isFailure(result.attempt), 'the late agent switched to Fluidcast');
    assertRefused(result.attempt.failure, 'session_deleting');
    assert.deepEqual(fluidcast.live(), []);
  }),
);

test(
  'an agent switched after the delete first read its worktree is still released before the cascade',
  withGitProject('ownership-delete-early-switch', async (rootPath, dataRoot) => {
    const reached = Effect.runSync(Deferred.make<void>());
    const proceed = Effect.runSync(Deferred.make<void>());
    // Command cleanup runs after the delete's first inventory and before its hold.
    const { fluidcast, layer } = ownershipWorld(
      dataRoot,
      undefined,
      Effect.andThen(Deferred.succeed(reached, undefined), Deferred.await(proceed)),
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { projectId, worktreeId } = yield* projectWithWorktree(rootPath);
        const deleting = yield* Effect.forkChild(
          (yield* WorkspaceService).deleteWorktree({
            projectId,
            worktreeId,
            request: { checkoutRemovalMode: 'force', branchRemovalMode: 'preserve' },
          }),
        );
        yield* Deferred.await(reached);
        const early = yield* placedAgent(worktreeId);
        const switched = yield* switchTo(early.agentSessionId, 'fluidcast');
        const liveBeforeHold = fluidcast.live();
        yield* Deferred.succeed(proceed, undefined);
        yield* Fiber.join(deleting);
        return { switched, liveBeforeHold };
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );
    assert.equal(result.switched.mode, 'fluidcast');
    assert.equal(result.liveBeforeHold.length, 1);
    // Read under the hold, the agent was released before its row cascaded away.
    assert.deepEqual(fluidcast.live(), []);
  }),
);

test(
  'after a worktree delete fails at git, its placed agents can switch and an earlier-deleted pane stays refused',
  withGitProject('ownership-delete-fails', async (rootPath, dataRoot) => {
    const { fluidcast, layer } = ownershipWorld(dataRoot, (args, options) =>
      Effect.fail(
        new GitCommandError({
          args,
          cause: new Error('fatal: worktree is locked'),
          cwd: options?.cwd,
          failure: { kind: 'exited', exitCode: 128 },
          stderr: 'fatal: worktree is locked',
        }),
      ),
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { projectId, worktreeId } = yield* projectWithWorktree(rootPath);
        const placed = yield* placedAgent(worktreeId);
        const retained = yield* placedAgent(worktreeId);
        // Retained: its pane is gone before the worktree delete starts; its row stays until GC.
        yield* (yield* SurfaceService).deleteSurface(retained.surfaceId);
        yield* switchTo(placed.agentSessionId, 'fluidcast');

        const failure = yield* Effect.flip(
          (yield* WorkspaceService).deleteWorktree({
            projectId,
            worktreeId,
            request: { checkoutRemovalMode: 'force', branchRemovalMode: 'preserve' },
          }),
        );
        const liveAfterRelease = fluidcast.live();
        const placedSwitch = yield* switchTo(placed.agentSessionId, 'fluidcast');
        const placedBack = yield* switchTo(placed.agentSessionId, 'terminal');
        const retainedRefusal = yield* Effect.flip(switchTo(retained.agentSessionId, 'fluidcast'));
        return { failure, liveAfterRelease, placedSwitch, placedBack, retainedRefusal };
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );
    assert.equal(result.failure._tag, 'GitCommandError');
    // The release ran before git failed, as a delete does; the failed delete ended its hold.
    assert.deepEqual(result.liveAfterRelease, []);
    assert.equal(result.placedSwitch.mode, 'fluidcast');
    assert.deepEqual(result.placedBack, { mode: 'terminal', fluidcastSessionId: null });
    assertRefused(result.retainedRefusal, 'session_not_placed');
  }),
);

test(
  'a retained agent re-placed through a real claim can switch again',
  withGitProject('ownership-claim', async (rootPath, dataRoot) => {
    const { fluidcast, layer } = ownershipWorld(dataRoot);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { worktreeId } = yield* projectWithWorktree(rootPath);
        const surfaces = yield* SurfaceService;
        const agent = yield* placedAgent(worktreeId);
        yield* surfaces.deleteSurface(agent.surfaceId);
        const whileRetained = yield* Effect.flip(switchTo(agent.agentSessionId, 'fluidcast'));

        const target = yield* surfaces.createSinglePaneSurface({ worktreeId, titleBase: 'Agent' });
        yield* surfaces.claimPaneSession({
          worktreeId,
          claim: {
            action: 'claim_agent_session',
            paneId: target.paneId,
            agentSessionId: agent.agentSessionId,
            expectedInteractionGeneration: 0,
          },
        });
        return { whileRetained, switched: yield* switchTo(agent.agentSessionId, 'fluidcast') };
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );
    assertRefused(result.whileRetained, 'session_not_placed');
    assert.equal(result.switched.mode, 'fluidcast');
    assert.equal(fluidcast.live().length, 1);
  }),
);

test(
  'an agent in a worktree added while its project is being deleted cannot switch, and nothing outlives the cascade',
  withGitProject('ownership-project-late-worktree', async (rootPath, dataRoot) => {
    const stopping = Effect.runSync(Deferred.make<void>());
    const proceed = Effect.runSync(Deferred.make<void>());
    // The delete pauses while it stops the existing agent's Fluidcast session (the first stop).
    let stops = 0;
    const { fluidcast, layer } = ownershipWorld(dataRoot, undefined, undefined, {
      onStop: () =>
        stops++ === 0
          ? Effect.andThen(Deferred.succeed(stopping, undefined), Deferred.await(proceed))
          : Effect.void,
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { projectId, worktreeId } = yield* projectWithWorktree(rootPath);
        const existing = yield* placedAgent(worktreeId);
        yield* switchTo(existing.agentSessionId, 'fluidcast');

        const workspace = yield* WorkspaceService;
        const deleting = yield* Effect.forkChild(workspace.deleteProject(projectId));
        yield* Deferred.await(stopping);
        // A worktree the delete never listed, with a new agent in it.
        const opened = yield* workspace.openWorktree({
          projectId,
          request: { branch: 'feature/late', base: { kind: 'branch', ref: 'main' } },
        });
        assert.equal(opened.status, 'created');
        const late = yield* placedAgent(opened.worktreeId);
        // Captured, not asserted yet: the paused delete must be let go whatever happens here.
        const attempt = yield* Effect.result(switchTo(late.agentSessionId, 'fluidcast'));
        yield* Deferred.succeed(proceed, undefined);
        const deleted = yield* Fiber.join(deleting);
        return { attempt, deleted };
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );
    assert.ok(Result.isFailure(result.attempt), 'the late agent switched to Fluidcast');
    assertRefused(result.attempt.failure, 'session_deleting');
    assert.equal(result.deleted.deleted, true);
    assert.deepEqual(fluidcast.live(), []);
  }),
);

test('every production consumer shares the one AgentSessionInteraction instance', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-ownership-shared-interaction-'));
  // A ready section builds the real `FluidcastSessions.layer` without any network call.
  writeFileSync(
    join(dataRoot, 'config.yaml'),
    [
      'fluidcast:',
      '  enabled: true',
      '  languageModel:',
      '    provider: openai',
      '    apiKey: sk-ownership-test',
      '    model: gpt-test',
      '  speech:',
      '    model: tts-test',
      '    apiKey: sk-ownership-test',
      '  preset:',
      '    voice:',
      '      name: alloy',
      '',
    ].join('\n'),
    'utf8',
  );
  const userShell = Layer.succeed(
    UserShell,
    UserShell.of({
      environment: { _tag: 'Available', values: { HOME: dataRoot, PATH: '/usr/bin:/bin' } },
      run: () => Effect.die('this test runs no user-shell command'),
    }),
  );
  const platform = Layer.mergeAll(
    RuntimeDatabase.layer,
    StateFile.layer,
    RuntimeConfig.layer,
    userShell,
  ).pipe(Layer.provideMerge(Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot))));
  // The app's composition, plus the production interaction and targets references merged into the
  // same build: the memo hands back the instances every consumer received.
  const app = Layer.mergeAll(
    ModulesLayer,
    AgentSessionInteraction.layer,
    HarnessObservationTargetsLayer,
  ).pipe(
    Layer.provide([WorkflowProjectErasure, HarnessObservationTargetsLayer]),
    Layer.provideMerge(platform),
    Layer.provide(testCliEntry),
  );
  try {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(app);
          return yield* Effect.gen(function* () {
            const worktreeId = yield* insertWorktree('/repo/isagi');
            const surfaces = yield* SurfaceService;
            const surface = yield* surfaces.createSinglePaneSurface({
              worktreeId,
              titleBase: 'Agent',
            });
            const agentSessionId = yield* insertAgentSessionForWorktree({
              worktreeId,
              paneId: surface.paneId,
              harness: 'claude',
            });
            const interaction = Context.get(context, AgentSessionInteraction);
            const fluidcastSessionId = 'fc-not-started' as FluidcastSessionId;
            interaction.setFluidcast(agentSessionId, {
              fluidcastSessionId,
              since: new Date().toISOString(),
            });

            const [target] = yield* (yield* HarnessObservationTargets).list({
              mode: 'one',
              id: agentSessionId,
            });
            const detail = yield* surfaces.getSurfaceDetail(surface.surfaceId);
            const pane = detail.panes[0]?.session;
            const attention = yield* (yield* AgentSessionAttentionProjection).listAttentionSources;
            return {
              fluidcastSessionId,
              execution: target?.activeExecution,
              pane: pane?.kind === 'agent_session' ? pane.agentSession : undefined,
              attention: attention.find((source) => source.source.id === agentSessionId)?.attention,
            };
          }).pipe(Effect.provide(context));
        }),
      ),
    );
    // The targets layer (the harness observer's port) sees the SDK execution.
    assert.equal(result.execution?.kind, 'sdk');
    assert.equal(result.execution?.incarnation, `sdk:${result.fluidcastSessionId}`);
    // Surfaces sees Fluidcast control; no session runs, so the worker reads as ended.
    assert.deepEqual(result.pane?.interaction, {
      mode: 'fluidcast',
      generation: 1,
      fluidcastSessionId: result.fluidcastSessionId,
    });
    assert.equal(result.pane?.status, 'failed');
    assert.equal(result.pane?.statusReason, 'agent_worker_failed');
    assert.equal(result.pane?.diagnosticDetail, 'session_missing');
    // The rail's attention agrees.
    assert.equal(result.attention, 'error');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
