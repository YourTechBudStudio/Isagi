import type { Session } from '@yourtechbudstudio/fluidcast-harness';
import type {
  Command,
  CommandRejected,
  ToolCommandRejected,
} from '@yourtechbudstudio/fluidcast-harness/protocol';
import type { WorkerHandle } from '@yourtechbudstudio/fluidcast-tool-agent';
import {
  Cause,
  Clock,
  Context,
  Deferred,
  type Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Scope,
  Stream,
} from 'effect';
import { FetchHttpClient } from 'effect/http';

import { AgentSessionArtifacts, HarnessAdapterRegistry } from '../harnesses/index.js';
import { InternalEvents } from '../platform/events/index.js';
import { LaunchEnvironment } from '../pty-processes/index.js';
import {
  resolveFluidcastKeys,
  RuntimeConfig,
  type FluidcastConfig,
  type FluidcastConfigState,
} from '../runtime-config/index.js';
import {
  FluidcastSessionNotFound,
  FluidcastSessionUnreadable,
  FluidcastStartFailed,
  FluidcastUnavailable,
} from './errors.js';
import { mintFluidcastSessionId, type FluidcastSessionId } from './ids.js';
import { buildFluidcastModels, type FluidcastModels } from './models.js';
import {
  buildFluidcastSession,
  sdkWorkers,
  type BuiltFluidcastSession,
  type FluidcastSessionInput,
} from './session-factory.js';

export type FluidcastAvailability = 'disabled' | 'ready' | 'invalid';

export interface LiveFluidcastSession {
  readonly fluidcastSessionId: FluidcastSessionId;
  readonly agentSessionId: number;
  readonly session: Session['Service'];
  readonly worker: WorkerHandle;
  /**
   * Applies one command in the session's own scope and waits for it. A command is one must-finish
   * sequence of session state changes, so interrupting the caller (a client that disconnects) stops
   * only the wait. Stopping the session or shutting down interrupts the command with the session;
   * the caller then sees `FluidcastSessionNotFound`.
   */
  readonly command: (
    command: Command,
  ) => Effect.Effect<void, CommandRejected | ToolCommandRejected | FluidcastSessionNotFound>;
  /** Completes when the session is stopped; per-instance streams end on it. */
  readonly ended: Effect.Effect<void>;
  readonly speechFormat: 'opus' | 'mp3' | 'wav';
}

/** The session's SDK execution as observation sees it: live until its worker faults. */
export interface FluidcastExecution {
  readonly since: string;
  readonly worker:
    | { readonly state: 'live' }
    | { readonly state: 'ended'; readonly reason: string };
}

export type FluidcastStartInput = Omit<FluidcastSessionInput, 'fluidcastSessionId'>;

/**
 * Builds one session in the current scope. Internal seam: production composes the Fluidcast SDKs
 * (`buildFluidcastSession`); the module's tests substitute fakes.
 */
export type FluidcastSessionBuilder = (
  input: FluidcastSessionInput,
  dependencies: { readonly config: FluidcastConfig; readonly models: FluidcastModels },
) => Effect.Effect<
  BuiltFluidcastSession,
  FluidcastSessionUnreadable | FluidcastStartFailed,
  Scope.Scope | HarnessAdapterRegistry | LaunchEnvironment
>;

interface Entry {
  readonly live: LiveFluidcastSession;
  readonly scope: Scope.Closeable;
  readonly ended: Deferred.Deferred<void>;
  execution: FluidcastExecution;
}

/**
 * How long a session build may take before it counts as hung. Attaching reads the native session
 * (Claude's transcript, Codex's `thread/read` over a spawned app-server), which can take a while for
 * a long history. The bound matters because the caller holds the agent's lock, which deletes need.
 */
export const fluidcastBuildTimeout: Duration.Input = '60 seconds';

/**
 * Live Fluidcast sessions as runtime-owned resources, like PTYs: each runs in its own child scope of
 * this layer, independent of any client, until it is stopped or the runtime shuts down. Nothing is
 * persisted. There is no service-level lock: callers sequence one agent's lifecycle with their own
 * per-agent lock.
 */
/**
 * Resolves a ready section's `env.NAME` keys against the environment Isagi gives the processes it
 * launches, which carries the login shell's variables. A variable that is unset leaves voice mode
 * unavailable, as an invalid section does; the log names the variable, never a value.
 */
const resolveKeys = (state: FluidcastConfigState) =>
  Effect.gen(function* () {
    if (state.status !== 'ready') return state;
    const resolved = resolveFluidcastKeys(state.config, yield* (yield* LaunchEnvironment).base);
    if (resolved.status === 'resolved') return { ...state, config: resolved.config };
    yield* Effect.logWarning('fluidcast key variables unset').pipe(
      Effect.annotateLogs({
        variables: resolved.unset
          .map(({ issuePath, variable }) => `${issuePath}: ${variable}`)
          .join(', '),
      }),
    );
    return {
      status: 'invalid',
      issuePaths: resolved.unset.map(({ issuePath }) => issuePath),
    } satisfies FluidcastConfigState;
  });

export const makeFluidcastSessions = (
  build: FluidcastSessionBuilder,
  options: { readonly buildTimeout: Duration.Input } = { buildTimeout: fluidcastBuildTimeout },
) =>
  Effect.gen(function* () {
    // Read once: changes to the section, and to the variables its keys name, take effect after a
    // restart.
    const state = yield* resolveKeys((yield* (yield* RuntimeConfig).get).fluidcast);
    const artifacts = yield* AgentSessionArtifacts;
    const events = yield* InternalEvents;
    const buildContext = yield* Effect.context<HarnessAdapterRegistry | LaunchEnvironment>();
    const layerScope = yield* Effect.scope;
    const entries = new Map<FluidcastSessionId, Entry>();

    if (state.status === 'invalid') {
      yield* Effect.logWarning('fluidcast config invalid').pipe(
        Effect.annotateLogs({ issuePaths: state.issuePaths.join(', ') }),
      );
    }
    const ready =
      state.status === 'ready'
        ? {
            config: state.config,
            models: yield* buildFluidcastModels(state.config).pipe(
              Effect.provide(FetchHttpClient.layer),
            ),
          }
        : undefined;

    // Per-instance streams end with their session, including at shutdown.
    yield* Effect.addFinalizer(() =>
      Effect.forEach(entries.values(), (entry) => Deferred.succeed(entry.ended, undefined), {
        discard: true,
      }),
    );

    /** The first native ID the worker reports, persisted for a session that started without one. */
    const recordNativeId = (entry: Entry) =>
      entry.live.worker.status.pipe(
        Stream.filter((summary) => summary.sessionId !== null),
        Stream.runHead,
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (summary) =>
              artifacts.writeHarnessSessionId({
                agentSessionId: entry.live.agentSessionId,
                harnessSessionId: summary.sessionId!,
              }),
          }),
        ),
        // The observer and Claude's own hook still record it; this only makes it earlier.
        Effect.catch((error) =>
          Effect.logWarning('fluidcast native session id not recorded').pipe(
            Effect.annotateLogs({
              agentSessionId: entry.live.agentSessionId,
              fluidcastSessionId: entry.live.fluidcastSessionId,
              reason: error.code,
            }),
          ),
        ),
      );

    const watchHealth = (entry: Entry) =>
      Effect.gen(function* () {
        const fault = yield* entry.live.worker.fault;
        entry.execution = {
          since: entry.execution.since,
          worker: { state: 'ended', reason: fault.reason },
        };
        yield* Effect.logWarning('fluidcast worker faulted').pipe(
          Effect.annotateLogs({
            agentSessionId: entry.live.agentSessionId,
            fluidcastSessionId: entry.live.fluidcastSessionId,
            reason: fault.reason,
          }),
        );
        yield* events.publish({
          type: 'agent_session_execution_changed',
          agentSessionId: entry.live.agentSessionId,
          change: { _tag: 'health' },
        });
      });

    const start = Effect.fn('FluidcastSessions.start')(function* (input: FluidcastStartInput) {
      if (ready === undefined) {
        return yield* new FluidcastUnavailable({
          reason: state.status === 'invalid' ? 'invalid_config' : 'disabled',
        });
      }
      const fluidcastSessionId = mintFluidcastSessionId();
      const since = new Date(yield* Clock.currentTimeMillis).toISOString();
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const scope = yield* Scope.fork(layerScope);
          // Only the build is interruptible; whatever ends it closes the session's scope. It is
          // interruptible even for a caller that is not (the mode change runs uninterruptibly), so
          // the timeout can cut a hung build instead of waiting for it.
          const built = yield* restore(
            Effect.interruptible(
              build({ ...input, fluidcastSessionId }, ready).pipe(
                Scope.provide(scope),
                Effect.provideContext(buildContext),
              ),
            ).pipe(
              Effect.timeoutOrElse({
                duration: options.buildTimeout,
                orElse: () =>
                  Effect.logWarning('fluidcast session build timed out').pipe(
                    Effect.annotateLogs({
                      agentSessionId: input.agentSessionId,
                      fluidcastSessionId,
                      harness: input.harness,
                    }),
                    Effect.andThen(
                      Effect.fail(new FluidcastStartFailed({ reason: 'session_build_failed' })),
                    ),
                  ),
              }),
            ),
          ).pipe(
            Effect.onExit((exit) =>
              Exit.isSuccess(exit) ? Effect.void : Scope.close(scope, exit),
            ),
            Effect.tapError((error) =>
              Effect.logWarning('fluidcast session start failed').pipe(
                Effect.annotateLogs({
                  agentSessionId: input.agentSessionId,
                  fluidcastSessionId,
                  error: error._tag,
                  reason: error.reason,
                }),
              ),
            ),
          );
          const ended = yield* Deferred.make<void>();
          const entry: Entry = {
            live: {
              fluidcastSessionId,
              agentSessionId: input.agentSessionId,
              session: built.session,
              worker: built.worker,
              command: (command) =>
                Effect.flatMap(Effect.forkIn(built.session.command(command), scope), (fiber) =>
                  Effect.flatMap(
                    Fiber.await(fiber),
                    (
                      exit,
                    ): Effect.Effect<
                      void,
                      CommandRejected | ToolCommandRejected | FluidcastSessionNotFound
                    > =>
                      Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
                        ? Effect.fail(new FluidcastSessionNotFound({ fluidcastSessionId }))
                        : exit,
                  ),
                ),
              ended: Deferred.await(ended),
              speechFormat: ready.config.speech.format,
            },
            scope,
            ended,
            execution: { since, worker: { state: 'live' } },
          };
          entries.set(fluidcastSessionId, entry);
          if (input.harnessSessionId === null) yield* Effect.forkIn(recordNativeId(entry), scope);
          yield* Effect.forkIn(watchHealth(entry), scope);
          yield* Effect.logInfo('fluidcast session started').pipe(
            Effect.annotateLogs({ agentSessionId: input.agentSessionId, fluidcastSessionId }),
          );
          return { fluidcastSessionId, since };
        }),
      );
    });

    const stop = Effect.fn('FluidcastSessions.stop')(function* (
      fluidcastSessionId: FluidcastSessionId,
    ) {
      const entry = entries.get(fluidcastSessionId);
      if (entry === undefined) return { harnessSessionId: null };
      entries.delete(fluidcastSessionId);
      yield* Deferred.succeed(entry.ended, undefined);
      // Harness finalizers first, then the worker's (Claude closes its query; Codex ends stdin,
      // then SIGTERM after 3 s).
      yield* Scope.close(entry.scope, Exit.void);
      // Read only now: the worker's ID is final once its reader has stopped, which includes a
      // `SessionStarted` the native-ID fiber had not yet persisted.
      const harnessSessionId = yield* entry.live.worker.sessionId;
      yield* Effect.logInfo('fluidcast session stopped').pipe(
        Effect.annotateLogs({ agentSessionId: entry.live.agentSessionId, fluidcastSessionId }),
      );
      return { harnessSessionId };
    }, Effect.uninterruptible);

    return FluidcastSessions.of({
      availability: state.status,
      start,
      stop,
      current: (fluidcastSessionId) => {
        const entry = entries.get(fluidcastSessionId as FluidcastSessionId);
        return entry === undefined
          ? Effect.fail(new FluidcastSessionNotFound({ fluidcastSessionId }))
          : Effect.succeed(entry.live);
      },
      execution: (fluidcastSessionId) => entries.get(fluidcastSessionId)?.execution,
    });
  });

export class FluidcastSessions extends Context.Service<
  FluidcastSessions,
  {
    /** From config, read once at startup. */
    readonly availability: FluidcastAvailability;
    /**
     * Starts a session for an agent. The caller has already checked the harness (`SdkHarness`)
     * and holds the agent's lock.
     */
    readonly start: (
      input: FluidcastStartInput,
    ) => Effect.Effect<
      { readonly fluidcastSessionId: FluidcastSessionId; readonly since: string },
      FluidcastUnavailable | FluidcastSessionUnreadable | FluidcastStartFailed
    >;
    /**
     * Closes the session and returns the worker's final native ID, read after its scope closed,
     * or `null` when no native session exists. Stopping an unknown session is a no-op.
     */
    readonly stop: (
      fluidcastSessionId: FluidcastSessionId,
    ) => Effect.Effect<{ readonly harnessSessionId: string | null }>;
    /** The live session behind a per-instance route; a stopped or unknown ID is not found. */
    readonly current: (
      fluidcastSessionId: string,
    ) => Effect.Effect<LiveFluidcastSession, FluidcastSessionNotFound>;
    readonly execution: (fluidcastSessionId: FluidcastSessionId) => FluidcastExecution | undefined;
  }
>()('isagi/runtime/fluidcast/FluidcastSessions') {
  static readonly layerNoDeps = Layer.effect(
    FluidcastSessions,
    makeFluidcastSessions((input, dependencies) =>
      buildFluidcastSession(input, { ...dependencies, workers: sdkWorkers }),
    ),
  );
  // Module dependencies are provided; platform services (`RuntimeConfig`, `UserShell`, the data
  // directory) stay open, as in the other module layers.
  static readonly layer = FluidcastSessions.layerNoDeps.pipe(
    Layer.provide([
      HarnessAdapterRegistry.layer,
      AgentSessionArtifacts.layer,
      LaunchEnvironment.layer,
      InternalEvents.layer,
    ]),
  );
}
