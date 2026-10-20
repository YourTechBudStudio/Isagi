import { Clock, Context, Data, Effect, Layer, Result, type Scope } from 'effect';

import type {
  AgentHarness,
  AgentSessionInteractionOrigin,
  FluidcastHandoffFailure,
} from '@isagi/contracts';

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
  type SdkHarness,
  sdkIncarnation,
} from '../../harnesses/index.js';
import {
  describeOperationalCause,
  describeSafely,
  type SafeDescription,
  type SafeDiagnostic,
} from '../../platform/diagnostics/index.js';
import { InternalEvents } from '../../platform/events/index.js';
import { DatabaseError } from '../../platform/persistence/index.js';
import { PtyService, type PtyLaunchError } from '../../pty-processes/index.js';
import { SessionLifecycle } from '../sessions/lifecycle.js';
import { sessionProcessIncarnation } from '../sessions/status.js';
import type { AgentSessionRow } from '../sessions/types.js';
import { AgentSessionInteraction, type AgentControl } from './interaction.js';
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
  /**
   * The interaction generation an attach token was issued under: refused with
   * `interaction_changed` when the agent's controller has changed since.
   */
  readonly controllerGeneration?: number | undefined;
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
  | 'session_deleting'
  /** The agent is not in terminal mode: Fluidcast controls it, or a switch to Fluidcast failed. */
  | 'not_in_terminal_mode'
  /** The request was made under an earlier controller than the agent's current one. */
  | 'interaction_changed';

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
  | FluidcastStartFailed
  | AgentTerminalStopFailed;

/**
 * An agent session operation was refused. Constructed positionally (`new AgentSessionError(code, message)`), as it was
 * before it became a tagged error, so existing call sites keep their shape.
 */
export class AgentSessionError
  extends Data.TaggedError('AgentSessionError')<{
    readonly code: AgentSessionErrorCode;
    readonly message: string;
  }>
  implements SafeDiagnostic
{
  constructor(code: AgentSessionErrorCode, message: string) {
    super({ code, message });
  }

  [describeSafely](): SafeDescription {
    return { label: `Agent session refused ${this.code}`, cause: null };
  }
}

/** The terminal stop that precedes a switch to Fluidcast reported an error, so Fluidcast was not started. */
export class AgentTerminalStopFailed extends Data.TaggedError('AgentTerminalStopFailed')<{
  readonly agentSessionId: number;
  readonly ptyProcessId: number;
  /** Rendered with `describeOperationalCause`, so it is safe to show and log. */
  readonly diagnostic: string;
}> {}

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

  /**
   * The agent's generation when it is in terminal mode. Reads in-memory state when run, and takes
   * no lock: a caller that needs the answer to stay current runs it while holding the agent's lock.
   */
  const requireTerminalMode = (agentSessionId: number, expectedGeneration?: number) =>
    Effect.suspend(() => {
      const current = interaction.get(agentSessionId);
      if (current.mode !== 'terminal')
        return Effect.fail(notInTerminalMode(agentSessionId, current.mode));
      if (expectedGeneration !== undefined && expectedGeneration !== current.generation)
        return Effect.logDebug('agent session request refused: controller changed').pipe(
          Effect.annotateLogs({
            agentSessionId,
            expectedGeneration,
            currentGeneration: current.generation,
          }),
          Effect.andThen(Effect.fail(interactionChanged(agentSessionId))),
        );
      return Effect.succeed(current.generation);
    });

  /** A switch's `from` must name the controller the agent is under now, read under its lock. */
  const assertCurrentController = (
    session: AgentSessionRow,
    control: AgentControl,
    from: AgentSessionInteractionOrigin,
  ) => {
    const fluidcastSessionId = control.mode === 'fluidcast' ? control.fluidcastSessionId : null;
    const processIncarnation = sessionProcessIncarnation(session, control);
    return from.generation === control.generation &&
      from.fluidcastSessionId === fluidcastSessionId &&
      from.processIncarnation === processIncarnation
      ? Effect.void
      : Effect.logDebug('agent interaction request refused: controller changed').pipe(
          Effect.annotateLogs({
            agentSessionId: session.id,
            expected: from,
            current: { generation: control.generation, fluidcastSessionId, processIncarnation },
          }),
          Effect.andThen(Effect.fail(interactionChanged(session.id))),
        );
  };

  /**
   * Records a switch to Fluidcast that failed after cleanup began, so the agent is never quietly
   * back in terminal mode. Taps expected errors and defects separately, so either continues as it
   * was. A reported stop failure ended nothing, so it publishes no null interval: the terminal's
   * own interval is still open.
   */
  const recordHandoffFailure =
    (agentSessionId: number) =>
    <A, R>(handoff: Effect.Effect<A, HandoffError, R>) => {
      const record = (failure: FluidcastHandoffFailure) =>
        Effect.gen(function* () {
          const generation = interaction.setFailed(agentSessionId, failure);
          yield* failure.code === 'terminal_stop_failed'
            ? publishChanged(agentSessionId)
            : publishControllerEnded(agentSessionId);
          yield* Effect.logWarning('agent session fluidcast handoff failed').pipe(
            Effect.annotateLogs({ agentSessionId, generation, ...failure }),
          );
        });
      return handoff.pipe(
        Effect.tapError((error) => record(classifyHandoffError(error))),
        Effect.tapDefect((defect) =>
          record({
            code: 'fluidcast_preparation_failed',
            diagnostic: describeOperationalCause(defect),
          }),
        ),
      );
    };

  /** The only cleanup failure a switch to Fluidcast honours: `PtyService.terminate` failing. */
  const stopTerminalForHandoff = (agentSessionId: number, ptyProcessId: number) =>
    pty.terminate({ ptyProcessId, gracefulTimeoutMs: 1_000 }).pipe(
      Effect.mapError(
        (error) =>
          new AgentTerminalStopFailed({
            agentSessionId,
            ptyProcessId,
            diagnostic: describeOperationalCause(error),
          }),
      ),
      Effect.asVoid,
    );

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

  const switchToFluidcast = Effect.fnUntraced(function* (
    agentSessionId: number,
    from: AgentSessionInteractionOrigin,
  ) {
    const session = yield* findAgentSessionOrFail(repository, agentSessionId);
    const control = interaction.control(agentSessionId);
    yield* assertCurrentController(session, control, from);
    if (control.mode === 'fluidcast')
      return { mode: 'fluidcast', fluidcastSessionId: control.fluidcastSessionId } as const;
    // Admission: every refusal happens before anything stops and leaves the state as it is,
    // including a `fluidcast_failed` record.
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
    return yield* handOffToFluidcast(session, harness).pipe(recordHandoffFailure(agentSessionId));
  });

  /** Cleanup, then the replacement. Every failure from here on is recorded as `fluidcast_failed`. */
  const handOffToFluidcast = Effect.fnUntraced(function* (
    session: AgentSessionRow,
    harness: SdkHarness,
  ) {
    // A stop that reports an error ends the handoff here: starting Fluidcast over a terminal that
    // may still be running would knowingly create a second writer.
    if (session.activePtyProcessId !== null && isLive(session.activePtyProcess))
      yield* stopTerminalForHandoff(session.id, session.activePtyProcessId);
    // Re-read: the terminal may have persisted its native ID while stopping. A known ID always
    // attaches; neither Isagi nor the SDK falls back to a new conversation for it.
    const latest = yield* findAgentSessionOrFail(repository, session.id);
    const started = yield* fluidcast.start({
      agentSessionId: session.id,
      harness,
      cwd: latest.cwd,
      harnessSessionId: latest.harnessSessionId,
    });
    interaction.setFluidcast(session.id, started);
    yield* publishSwitched(session.id, sdkIncarnation(started.fluidcastSessionId), started.since);
    yield* publishChanged(session.id);
    return { mode: 'fluidcast', fluidcastSessionId: started.fluidcastSessionId } as const;
  });

  /**
   * Keeps a live PTY; otherwise launches one with the stored native ID (a resume, or fresh when
   * none was recorded). Whether it launched, so the caller decides what to publish.
   */
  const ensureTerminalRunning = Effect.fnUntraced(function* (session: AgentSessionRow) {
    if (isLive(session.activePtyProcess)) return false;
    yield* validateHarnessMetadata(session);
    yield* launchProcessForSession(session);
    return true;
  });

  const switchToTerminal = Effect.fnUntraced(function* (
    agentSessionId: number,
    from: AgentSessionInteractionOrigin,
  ) {
    const session = yield* findAgentSessionOrFail(repository, agentSessionId);
    const control = interaction.control(agentSessionId);
    yield* assertCurrentController(session, control, from);
    // A terminal switch must not launch a PTY for an owner that is going away either.
    yield* assertMayCreateController(session);
    if (control.mode === 'terminal') {
      if (yield* ensureTerminalRunning(session)) yield* publishChanged(agentSessionId);
      return terminalResult;
    }
    if (control.mode === 'fluidcast_failed') {
      // Back to terminal: terminal mode first, so a launch that fails leaves the pane's own
      // recovery (Resume / Start fresh) in charge. The record changed either way. A terminal whose
      // stop failed is still live and is kept; its interval never closed.
      interaction.setTerminal(agentSessionId);
      yield* ensureTerminalRunning(session).pipe(Effect.ensuring(publishChanged(agentSessionId)));
      return terminalResult;
    }
    interaction.setTerminal(agentSessionId);
    // Final once the worker's scope has closed: no `SessionStarted` can arrive later.
    const stopped = yield* fluidcast.stop(control.fluidcastSessionId);
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
            interaction.setTerminal(agentSessionId);
            yield* fluidcast.stop(current.fluidcastSessionId);
            ended = true;
          } else if (current.mode === 'fluidcast_failed') {
            interaction.setTerminal(agentSessionId);
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
            ? switchToFluidcast(input.agentSessionId, input.from)
            : switchToTerminal(input.agentSessionId, input.from),
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
            // Every branch below creates or hands out a terminal controller, so none runs while
            // Fluidcast controls the agent or its switch failed. Switches launch directly, never
            // through here.
            yield* requireTerminalMode(agentSessionId, options?.controllerGeneration);
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
    requireTerminalMode,
    withRunningTerminal: (agentSessionId, generation, use) =>
      lifecycle
        .withRestoreLock(
          { kind: 'agent_session', sessionId: agentSessionId },
          Effect.gen(function* () {
            yield* requireTerminalMode(agentSessionId, generation);
            const session = yield* findAgentSessionOrFail(repository, agentSessionId);
            return yield* use(yield* runningPtyProcessId(session));
          }),
        )
        .pipe(Effect.withSpan('AgentSessionService.withRunningTerminal')),
    isControllerLive: Effect.fn('AgentSessionService.isControllerLive')(function* (agentSessionId) {
      const control = interaction.control(agentSessionId);
      if (control.mode === 'fluidcast') return control.worker.state === 'live';
      const session = yield* findAgentSessionOrFail(repository, agentSessionId);
      return Result.isSuccess(yield* Effect.result(runningPtyProcessId(session)));
    }),
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
    /**
     * The agent's generation when it is in terminal mode; `not_in_terminal_mode` otherwise, and
     * `interaction_changed` when `expectedGeneration` is given and differs. Reads in-memory state
     * only and takes no lock: a caller that needs the answer to stay current calls it while
     * holding the agent's lock.
     */
    readonly requireTerminalMode: (
      agentSessionId: number,
      expectedGeneration?: number,
    ) => Effect.Effect<number, AgentSessionError>;
    /**
     * Under the agent's lock: refuses unless the agent is in terminal mode at `generation`,
     * resolves its running PTY, then runs `use` with the lock still held. `use` must not take the
     * agent's lock again.
     */
    readonly withRunningTerminal: <A, E, R>(
      agentSessionId: number,
      generation: number,
      use: (ptyProcessId: number) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | DatabaseError | AgentSessionError, R>;
    /**
     * Whether the agent's current controller can still act: its Fluidcast worker in `fluidcast`
     * mode, otherwise a running PTY.
     */
    readonly isControllerLive: (
      agentSessionId: number,
    ) => Effect.Effect<boolean, DatabaseError | AgentSessionError>;
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
     * Switches the agent between its terminal and a Fluidcast session under its lock: the `from`
     * check, admission, cleanup of the old controller, then the replacement. Idempotent per mode
     * for a current `from`. A switch to Fluidcast that fails after cleanup began leaves the agent
     * in `fluidcast_failed`; switching to terminal from there is Back to terminal, and to
     * Fluidcast is Retry.
     */
    readonly setInteractionMode: (input: {
      readonly agentSessionId: number;
      readonly mode: 'terminal' | 'fluidcast';
      readonly from: AgentSessionInteractionOrigin;
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

/**
 * The refusal of terminal work while the agent is not in terminal mode. A workflow author reads it
 * on a failed `send_prompt`, so it says what to do.
 */
export function notInTerminalMode(
  agentSessionId: number,
  mode: 'fluidcast' | 'fluidcast_failed',
): AgentSessionError {
  return new AgentSessionError(
    'not_in_terminal_mode',
    `Agent session ${agentSessionId} isn't in terminal mode: ${mode === 'fluidcast' ? 'Fluidcast controls it' : 'its switch to Fluidcast failed'}. Switch its pane back to the terminal, then retry.`,
  );
}

function interactionChanged(agentSessionId: number) {
  return new AgentSessionError(
    'interaction_changed',
    `Agent session ${agentSessionId} changed controllers after this request was made.`,
  );
}

/** Everything a handoff to Fluidcast can fail with once cleanup has begun. */
type HandoffError =
  | AgentTerminalStopFailed
  | FluidcastUnavailable
  | FluidcastSessionUnreadable
  | FluidcastStartFailed
  | DatabaseError
  | AgentSessionError;

function classifyHandoffError(error: HandoffError): FluidcastHandoffFailure {
  switch (error._tag) {
    case 'AgentTerminalStopFailed':
      return { code: 'terminal_stop_failed', diagnostic: error.diagnostic };
    case 'FluidcastSessionUnreadable':
      return { code: 'fluidcast_session_unreadable', reason: error.reason };
    case 'FluidcastStartFailed':
      return { code: 'fluidcast_start_failed', reason: error.reason };
    // `FluidcastUnavailable` here is the start's own re-check losing a race with a config change.
    case 'FluidcastUnavailable':
    case 'DatabaseError':
    case 'AgentSessionError':
      return { code: 'fluidcast_preparation_failed', diagnostic: describeOperationalCause(error) };
  }
}

/** The session's PTY when it is running; the refusals a write into it needs. */
function runningPtyProcessId(session: AgentSessionRow) {
  if (!session.activePtyProcessId || !session.activePtyProcess)
    return Effect.fail(
      new AgentSessionError(
        'active_process_missing',
        `Agent session ${session.id} has no active PTY process.`,
      ),
    );
  if (session.activePtyProcess.status !== 'running')
    return Effect.fail(
      new AgentSessionError(
        'active_process_not_running',
        `Agent session ${session.id} active process is not running.`,
      ),
    );
  return Effect.succeed(session.activePtyProcessId);
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
