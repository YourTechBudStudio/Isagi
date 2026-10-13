import { Clock, Context, Data, Effect, Layer, Result } from 'effect';

import type { AgentHarness } from '@isagi/contracts';

import {
  HarnessControlPlane,
  type HarnessLaunchBlocked,
  HarnessAdapterRegistry,
  HarnessAdapterError,
  type HarnessLaunchOptions,
  ptyIncarnation,
} from '../../harnesses/index.js';
import { InternalEvents } from '../../platform/events/index.js';
import { DatabaseError } from '../../platform/persistence/index.js';
import { PtyService, type PtyLaunchError } from '../../pty-processes/index.js';
import { SessionLifecycle } from '../sessions/lifecycle.js';
import type { AgentSessionRow } from '../sessions/types.js';
import { AgentSessionRepository } from './repository.js';

export type StopUnlessPlacedOutcome =
  | { readonly kind: 'placed'; readonly surfaceId: number; readonly paneId: number }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'stop_failed'; readonly cause: unknown };

export interface AgentSessionEnsureActiveOptions extends HarnessLaunchOptions {
  readonly replaceEphemeralProcess?: boolean | undefined;
}

export type AgentSessionErrorCode =
  | 'session_not_found'
  | 'active_process_missing'
  | 'active_process_not_running'
  | 'harness_metadata_missing'
  | 'harness_metadata_invalid';

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

  const publishChanged = (agentSessionId: number) =>
    eventBus.publish({ type: 'agent_session_changed', agentSessionId });

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

  return AgentSessionService.of({
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
  }
>()('isagi/runtime/environment/AgentSessionService') {
  static readonly layerNoDeps = Layer.effect(AgentSessionService, make);
  static readonly layer = AgentSessionService.layerNoDeps.pipe(
    Layer.provide([
      AgentSessionRepository.layer,
      HarnessAdapterRegistry.layer,
      HarnessControlPlane.layer,
      InternalEvents.layer,
      PtyService.layer,
      SessionLifecycle.layer,
    ]),
  );
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
