import { Clock, Context, Data, Effect, Layer, Result, type Scope } from 'effect';

import type { AgentHarness } from '@isagi/contracts';

import {
  FluidcastSessions,
  FluidcastUnavailable,
  type FluidcastSessionId,
  type FluidcastSessionUnreadable,
  type FluidcastStartFailed,
} from '../../fluidcast/index.js';
import {
  AgentSessionArtifacts,
  HarnessControlPlane,
  type HarnessLaunchBlocked,
  HarnessAdapterRegistry,
  HarnessAdapterError,
  type HarnessLaunchOptions,
  type Incarnation,
  ptyIncarnation,
  sdkIncarnation,
} from '../../harnesses/index.js';
import { InternalEvents } from '../../platform/events/index.js';
import { DatabaseError } from '../../platform/persistence/index.js';
import { PtyService, type PtyLaunchError } from '../../pty-processes/index.js';
import { SessionLifecycle } from '../sessions/lifecycle.js';
import type { AgentSessionRow } from '../sessions/types.js';
import { AgentSessionInteraction } from './interaction.js';
import { AgentSessionRepository } from './repository.js';

export type StopUnlessPlacedOutcome =
  | { readonly kind: 'placed'; readonly surfaceId: number; readonly paneId: number }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'stop_failed'; readonly cause: unknown };

export interface AgentSessionEnsureActiveOptions extends HarnessLaunchOptions {
  readonly replaceEphemeralProcess?: boolean | undefined;
  /**
   * Attach to this live incarnation only: never launch or replace a process, and refuse with
   * `process_incarnation_stale` when the session's live process is another one or none.
   */
  readonly expectedIncarnation?: Incarnation | undefined;
}

export type AgentSessionErrorCode =
  | 'session_not_found'
  | 'active_process_missing'
  | 'active_process_not_running'
  /** The incarnation an attach named is no longer the session's live process. */
  | 'process_incarnation_stale'
  | 'harness_metadata_missing'
  | 'harness_metadata_invalid'
  /** No pane holds the session any more, so it may not get a new controller. */
  | 'session_not_placed'
  /** A worktree or project delete holds the session's worktree or project. */
  | 'session_deleting';

export interface InteractionModeResult {
  readonly mode: 'terminal' | 'fluidcast';
  readonly fluidcastSessionId: FluidcastSessionId | null;
}

export type SetInteractionModeError =
  | DatabaseError
  | AgentSessionError
  | HarnessLaunchBlocked
  | HarnessAdapterError
  | PtyLaunchError
  | FluidcastUnavailable
  | FluidcastSessionUnreadable
  | FluidcastStartFailed;

/**
 * An agent session operation was refused. Constructed positionally (`new AgentSessionError(code, message)`), as it was
 * before it became a tagged error, so existing call sites keep their shape.
 */
export class AgentSessionError extends Data.TaggedError('AgentSessionError')<{
  readonly code: AgentSessionErrorCode;
  readonly message: string;
}> {
  constructor(code: AgentSessionErrorCode, message: string) {
    super({ code, message });
  }
}

const make = Effect.gen(function* () {
  const repository = yield* AgentSessionRepository;
  const pty = yield* PtyService;
  const harnesses = yield* HarnessAdapterRegistry;
  const eventBus = yield* InternalEvents;
  const lifecycle = yield* SessionLifecycle;
  const controlPlane = yield* HarnessControlPlane;
  const artifacts = yield* AgentSessionArtifacts;
  const interaction = yield* AgentSessionInteraction;
  const fluidcast = yield* FluidcastSessions;

  const publishChanged = (agentSessionId: number) =>
    eventBus.publish({ type: 'agent_session_changed', agentSessionId });

  const now = Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis).toISOString());

  const publishSwitched = (
    agentSessionId: number,
    incarnation: Incarnation | null,
    since: string,
  ) =>
    eventBus.publish({
      type: 'agent_session_execution_changed',
      agentSessionId,
      change: { _tag: 'switched', interval: { incarnation, since } },
    });

  /** The controller ended and nothing replaced it. */
  const publishControllerEnded = (agentSessionId: number) =>
    Effect.gen(function* () {
      yield* publishSwitched(agentSessionId, null, yield* now);
      yield* publishChanged(agentSessionId);
    });

  /**
   * A new controller is created only for a session a pane still holds, in a worktree and project
   * no delete holds. Every delete makes one of these false before its release takes the session's
   * lock, so a switch queued behind a release is refused. Holds are on the worktree or project, so
   * they also refuse agents (and, for a project, worktrees) created after the delete read its
   * inventory.
   */
  const assertMayCreateController = Effect.fnUntraced(function* (session: AgentSessionRow) {
    if ((yield* repository.findPlacement(session.id)) === null)
      return yield* new AgentSessionError(
        'session_not_placed',
        `Agent session ${session.id} is not placed in a pane.`,
      );
    const projectId = yield* repository.findProjectId(session.worktreeId);
    if (interaction.isHeldForDeletion({ worktreeId: session.worktreeId, projectId }))
      return yield* new AgentSessionError(
        'session_deleting',
        `Agent session ${session.id} is being deleted with its worktree.`,
      );
  });

  /** Best-effort: a PTY that does not stop is logged, and the caller carries on. */
  const terminatePty = (agentSessionId: number, ptyProcessId: number) =>
    pty.terminate({ ptyProcessId, gracefulTimeoutMs: 1_000 }).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning('agent session PTY not stopped').pipe(
          Effect.annotateLogs({ agentSessionId, ptyProcessId, reason: error._tag }),
          Effect.as(false),
        ),
      ),
    );

  const launchProcessForSession = Effect.fnUntraced(function* (
    session: AgentSessionRow,
    options?: HarnessLaunchOptions,
  ) {
    yield* controlPlane.assertCanCreateProcess(session.harness);
    const launch = yield* agentLaunchEnvelope(harnesses, session, options);
    // Read before the process exists: a lower bound on anything it writes, which Codex rollout
    // attribution relies on.
    const since = new Date(yield* Clock.currentTimeMillis).toISOString();
    const process = yield* pty.launch(launch);
    yield* repository.setActivePtyProcess({
      agentSessionId: session.id,
      ptyProcessId: process.ptyProcessId,
    });
    yield* eventBus.publish({
      type: 'agent_session_execution_changed',
      agentSessionId: session.id,
      change: {
        _tag: 'switched',
        interval: { incarnation: ptyIncarnation(process.ptyProcessId), since },
      },
    });
    return process.ptyProcessId;
  });

  const switchToFluidcast = Effect.fnUntraced(function* (agentSessionId: number) {
    const session = yield* findAgentSessionOrFail(repository, agentSessionId);
    const current = interaction.get(agentSessionId);
    if (current.mode === 'fluidcast')
      return { mode: 'fluidcast', fluidcastSessionId: current.fluidcastSessionId } as const;
    // Admission: every refusal happens before anything stops.
    yield* assertMayCreateController(session);
    yield* validateHarnessMetadata(session);
    if (fluidcast.availability !== 'ready')
      return yield* new FluidcastUnavailable({
        reason: fluidcast.availability === 'invalid' ? 'invalid_config' : 'disabled',
      });
    const harness = session.harness;
    if (!harnesses.supportsSdk(harness))
      return yield* new FluidcastUnavailable({ reason: 'harness_unsupported' });
    yield* controlPlane.assertCanCreateProcess(harness);
    // Cleanup before replacement, so the native session has one writer.
    if (session.activePtyProcessId !== null && isLive(session.activePtyProcess))
      yield* terminatePty(agentSessionId, session.activePtyProcessId);
    const started = yield* fluidcast
      .start({
        agentSessionId,
        harness,
        cwd: session.cwd,
        harnessSessionId: session.harnessSessionId,
      })
      // The terminal is already stopped and the mode stays terminal.
      .pipe(Effect.tapError(() => publishControllerEnded(agentSessionId)));
    interaction.set(agentSessionId, started);
    yield* publishSwitched(
      agentSessionId,
      sdkIncarnation(started.fluidcastSessionId),
      started.since,
    );
    yield* publishChanged(agentSessionId);
    return { mode: 'fluidcast', fluidcastSessionId: started.fluidcastSessionId } as const;
  });

  const switchToTerminal = Effect.fnUntraced(function* (agentSessionId: number) {
    const session = yield* findAgentSessionOrFail(repository, agentSessionId);
    // A terminal switch must not launch a PTY for an owner that is going away either.
    yield* assertMayCreateController(session);
    const current = interaction.get(agentSessionId);
    if (current.mode === 'terminal') {
      if (isLive(session.activePtyProcess)) return terminalResult;
      yield* validateHarnessMetadata(session);
      yield* launchProcessForSession(session);
      yield* publishChanged(agentSessionId);
      return terminalResult;
    }
    interaction.delete(agentSessionId);
    // Final once the worker's scope has closed: no `SessionStarted` can arrive later.
    const stopped = yield* fluidcast.stop(current.fluidcastSessionId);
    yield* Effect.gen(function* () {
      const latest = yield* findAgentSessionOrFail(repository, agentSessionId);
      // The worker may have created the native session without the ID being persisted yet (or
      // at all): resume it anyway, so the terminal continues the same conversation.
      const known = latest.harnessSessionId ?? stopped.harnessSessionId;
      if (latest.harnessSessionId === null && known !== null)
        yield* artifacts
          .writeHarnessSessionId({ agentSessionId, harnessSessionId: known })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning('agent native session id not recorded').pipe(
                Effect.annotateLogs({ agentSessionId, reason: error.code }),
              ),
            ),
          );
      yield* validateHarnessMetadata(latest);
      yield* launchProcessForSession({ ...latest, harnessSessionId: known });
    }).pipe(
      // The Fluidcast session is already gone and nothing replaced it.
      Effect.tapError(() => publishControllerEnded(agentSessionId)),
    );
    yield* publishChanged(agentSessionId);
    return terminalResult;
  });

  /** Ends the agent's current controller, whichever kind, read under its lock. */
  const releaseController = (agentSessionId: number) =>
    Effect.uninterruptible(
      lifecycle.withRestoreLock(
        { kind: 'agent_session', sessionId: agentSessionId },
        Effect.gen(function* () {
          let ended = false;
          const current = interaction.get(agentSessionId);
          if (current.mode === 'fluidcast') {
            interaction.delete(agentSessionId);
            yield* fluidcast.stop(current.fluidcastSessionId);
            ended = true;
          }
          // Read now, under the lock: a terminal switch that held the lock before this release
          // may have launched a replacement after the caller read its pointers.
          const row = yield* repository.find(agentSessionId);
          if (row !== null && row.activePtyProcessId !== null && isLive(row.activePtyProcess))
            ended = (yield* terminatePty(agentSessionId, row.activePtyProcessId)) || ended;
          if (ended) yield* publishControllerEnded(agentSessionId);
        }),
      ),
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning('agent session controller not released').pipe(
          Effect.annotateLogs({ agentSessionId, reason: error._tag }),
        ),
      ),
    );

  return AgentSessionService.of({
    setInteractionMode: Effect.fn('AgentSessionService.setInteractionMode')(function* (input) {
      // Waiting for the lock stays interruptible, so a caller that has gone away does not run a
      // stale switch later. Once held, the switch cannot be cut in half.
      return yield* lifecycle.withRestoreLock(
        { kind: 'agent_session', sessionId: input.agentSessionId },
        Effect.uninterruptible<InteractionModeResult, SetInteractionModeError, never>(
          input.mode === 'fluidcast'
            ? switchToFluidcast(input.agentSessionId)
            : switchToTerminal(input.agentSessionId),
        ),
      );
    }),
    // Deletes call this after they have committed (or while holding the agents), so even the wait
    // for the lock is uninterruptible: a skipped release would leave a controller running until
    // restart. Each wait is bounded by the switch it queues behind.
    releaseControllers: (agentSessionIds) =>
      Effect.forEach(agentSessionIds, releaseController, {
        concurrency: 'unbounded',
        discard: true,
      }).pipe(Effect.withSpan('AgentSessionService.releaseControllers')),
    holdWorktreesForDeletion: (worktreeIds) =>
      interaction.holdForDeletion(worktreeIds.map((worktreeId) => ({ worktreeId }))),
    holdProjectForDeletion: (projectId) => interaction.holdForDeletion([{ projectId }]),
    startFresh: Effect.fn('AgentSessionService.startFresh')(function* (input) {
      yield* controlPlane.assertCanCreateProcess(input.harness);
      const agentSessionId = yield* repository.create({
        worktreeId: input.worktreeId,
        harness: input.harness,
        cwd: input.cwd,
      });
      yield* publishChanged(agentSessionId);
      return { agentSessionId };
    }),
    get: Effect.fn('AgentSessionService.get')(function* (agentSessionId) {
      return yield* findAgentSessionOrFail(repository, agentSessionId);
    }),
    ensureActivePtyProcess: Effect.fn('AgentSessionService.ensureActivePtyProcess')(
      function* (agentSessionId, options) {
        return yield* lifecycle.withRestoreLock(
          { kind: 'agent_session', sessionId: agentSessionId },
          Effect.gen(function* () {
            const session = yield* findAgentSessionOrFail(repository, agentSessionId);
            if (options?.expectedIncarnation !== undefined)
              return yield* expectLiveIncarnation(session, options.expectedIncarnation);
            yield* validateHarnessMetadata(session);
            const process = session.activePtyProcess;
            const replaceEphemeralProcess =
              options?.replaceEphemeralProcess === true && process?.backend === 'node_pty';
            const canReuseActiveProcess =
              session.activePtyProcessId &&
              !replaceEphemeralProcess &&
              (process?.status === 'running' || process?.status === 'starting');
            if (canReuseActiveProcess) {
              return session.activePtyProcessId;
            }
            return yield* launchProcessForSession(session, options);
          }),
        );
      },
    ),
    stopUnlessPlaced: Effect.fn('AgentSessionService.stopUnlessPlaced')(function* (input) {
      return yield* lifecycle.withRestoreLock(
        { kind: 'agent_session', sessionId: input.agentSessionId },
        Effect.gen(function* () {
          const placement = yield* repository.findPlacement(input.agentSessionId);
          if (placement) return { kind: 'placed', ...placement } as const;
          const stopped = yield* pty
            .terminate({ ptyProcessId: input.ptyProcessId, gracefulTimeoutMs: 1_000 })
            .pipe(Effect.result);
          return Result.isSuccess(stopped)
            ? ({ kind: 'stopped' } as const)
            : ({ kind: 'stop_failed', cause: stopped.failure } as const);
        }),
      );
    }),
    activePtyProcessId: Effect.fn('AgentSessionService.activePtyProcessId')(
      function* (agentSessionId) {
        const session = yield* findAgentSessionOrFail(repository, agentSessionId);
        if (!session.activePtyProcessId || !session.activePtyProcess)
          return yield* new AgentSessionError(
            'active_process_missing',
            `Agent session ${agentSessionId} has no active PTY process.`,
          );
        if (session.activePtyProcess.status !== 'running')
          return yield* new AgentSessionError(
            'active_process_not_running',
            `Agent session ${agentSessionId} active process is not running.`,
          );
        return session.activePtyProcessId;
      },
    ),
  });
});

export class AgentSessionService extends Context.Service<
  AgentSessionService,
  {
    readonly startFresh: (input: {
      readonly worktreeId: number;
      readonly harness: AgentHarness;
      readonly cwd: string;
    }) => Effect.Effect<{ readonly agentSessionId: number }, DatabaseError | HarnessLaunchBlocked>;
    readonly get: (
      agentSessionId: number,
    ) => Effect.Effect<AgentSessionRow, DatabaseError | AgentSessionError>;
    readonly ensureActivePtyProcess: (
      agentSessionId: number,
      options?: AgentSessionEnsureActiveOptions,
    ) => Effect.Effect<
      number,
      | DatabaseError
      | AgentSessionError
      | PtyLaunchError
      | HarnessAdapterError
      | HarnessLaunchBlocked
    >;
    readonly activePtyProcessId: (
      agentSessionId: number,
    ) => Effect.Effect<number, DatabaseError | AgentSessionError>;
    /**
     * Stops a process its launcher started, unless a pane holds the session. The
     * placement read and the stop happen under the session's lock, which a claim
     * also takes to bind the session, so a claim can never land between them: a
     * session placed at any point up to the decision keeps its process.
     */
    readonly stopUnlessPlaced: (input: {
      readonly agentSessionId: number;
      readonly ptyProcessId: number;
    }) => Effect.Effect<StopUnlessPlacedOutcome, DatabaseError>;
    /**
     * Switches the agent between its terminal and a Fluidcast session under its lock: admission,
     * best-effort cleanup of the old controller, then the replacement. Idempotent per mode.
     */
    readonly setInteractionMode: (input: {
      readonly agentSessionId: number;
      readonly mode: 'terminal' | 'fluidcast';
    }) => Effect.Effect<InteractionModeResult, SetInteractionModeError>;
    /**
     * Ends each agent's current controller (Fluidcast session or PTY), read under its lock. Never
     * fails, launches nothing, and is idempotent.
     */
    readonly releaseControllers: (agentSessionIds: ReadonlyArray<number>) => Effect.Effect<void>;
    /**
     * Holds every agent of these worktrees against new controllers, including agents created
     * later, until the calling scope closes (worktree and project delete). Take it before reading
     * the agents to release.
     */
    readonly holdWorktreesForDeletion: (
      worktreeIds: ReadonlyArray<number>,
    ) => Effect.Effect<void, never, Scope.Scope>;
    /**
     * Holds every agent of the project, including agents of worktrees added later, until the
     * calling scope closes (project delete). Take it before listing the worktrees.
     */
    readonly holdProjectForDeletion: (projectId: number) => Effect.Effect<void, never, Scope.Scope>;
  }
>()('isagi/runtime/environment/AgentSessionService') {
  static readonly layerNoDeps = Layer.effect(AgentSessionService, make);
  static readonly layer = AgentSessionService.layerNoDeps.pipe(
    Layer.provide([
      AgentSessionArtifacts.layer,
      AgentSessionInteraction.layer,
      AgentSessionRepository.layer,
      FluidcastSessions.layer,
      HarnessAdapterRegistry.layer,
      HarnessControlPlane.layer,
      InternalEvents.layer,
      PtyService.layer,
      SessionLifecycle.layer,
    ]),
  );
}

const terminalResult: InteractionModeResult = { mode: 'terminal', fluidcastSessionId: null };

function expectLiveIncarnation(session: AgentSessionRow, expected: Incarnation) {
  return session.activePtyProcessId !== null &&
    isLive(session.activePtyProcess) &&
    ptyIncarnation(session.activePtyProcessId) === expected
    ? Effect.succeed(session.activePtyProcessId)
    : Effect.fail(
        new AgentSessionError(
          'process_incarnation_stale',
          `Agent session ${session.id} is no longer running ${expected}.`,
        ),
      );
}

function isLive(process: AgentSessionRow['activePtyProcess']) {
  return process?.status === 'starting' || process?.status === 'running';
}

const findAgentSessionOrFail = Effect.fnUntraced(function* (
  repository: AgentSessionRepository['Service'],
  agentSessionId: number,
) {
  const session = yield* repository.find(agentSessionId);
  if (!session) {
    return yield* new AgentSessionError(
      'session_not_found',
      `Agent session ${agentSessionId} was not found.`,
    );
  }
  return session;
});

/** Restoring a session whose harness metadata is missing or invalid would lose its resume identity, so it is refused. */
const validateHarnessMetadata = Effect.fnUntraced(function* (session: AgentSessionRow) {
  if (session.harnessMetadataStatus === 'valid') return;
  const missing = session.harnessMetadataStatus === 'missing';
  yield* Effect.logWarning(
    missing
      ? 'Agent session restoration blocked: missing harness metadata'
      : 'Agent session restoration blocked: invalid harness metadata',
  ).pipe(
    Effect.annotateLogs({
      agentSessionId: session.id,
      harness: session.harness,
      diagnostic: session.harnessMetadataDiagnostic,
    }),
  );
  return yield* missing
    ? new AgentSessionError(
        'harness_metadata_missing',
        `Agent session ${session.id} cannot be restored because harness metadata is missing.`,
      )
    : new AgentSessionError(
        'harness_metadata_invalid',
        `Agent session ${session.id} cannot be restored because harness metadata is invalid.`,
      );
});

function agentLaunchEnvelope(
  harnesses: HarnessAdapterRegistry['Service'],
  session: AgentSessionRow,
  options?: HarnessLaunchOptions,
) {
  return harnesses.buildLaunch({
    agentSessionId: session.id,
    harness: session.harness,
    cwd: session.cwd,
    latestHarnessSessionId: session.harnessSessionId,
    model: options?.model,
    effort: options?.effort,
  });
}
