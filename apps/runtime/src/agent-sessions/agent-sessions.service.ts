import { Context, Effect, Layer } from 'effect';

import type { AgentHarness, LaunchAgentSessionOutput } from '@isagi/contracts';

import { HarnessAdapterError, HarnessAdapterRegistry } from '../harness-adapters/index.js';
import { DatabaseError } from '../persistence/index.js';
import { PtyService, type PtyLaunchError } from '../pty-processes/pty.service.js';
import { titleForHarness } from '../pty-processes/service/runtime-namespace.js';
import { InternalRuntimeEventBus } from '../runtime-events/index.js';
import { SurfaceRepository } from '../surfaces/index.js';
import type { AgentSessionRow } from '../surfaces/types.js';
import { AgentSessionRepository } from './agent-sessions.repository.js';

export interface AgentSessionService {
  readonly launch: (input: {
    readonly worktreeId: number;
    readonly harness: AgentHarness;
  }) => Effect.Effect<
    LaunchAgentSessionOutput,
    DatabaseError | PtyLaunchError | HarnessAdapterError
  >;
  readonly ensureActivePtyProcess: (
    agentSessionId: number,
  ) => Effect.Effect<
    number,
    DatabaseError | AgentSessionError | PtyLaunchError | HarnessAdapterError
  >;
  readonly activePtyProcessId: (
    agentSessionId: number,
  ) => Effect.Effect<number, DatabaseError | AgentSessionError>;
  readonly recordHarnessSessionObservation: (input: {
    readonly agentSessionId: number;
    readonly ptyProcessId: number;
    readonly harness: AgentHarness;
    readonly harnessSessionId: string;
    readonly source: string | null;
  }) => Effect.Effect<void, DatabaseError | AgentSessionError>;
}

export class AgentSessionError extends Error {
  readonly _tag = 'AgentSessionError';
  constructor(
    readonly code:
      | 'session_not_found'
      | 'active_process_missing'
      | 'active_process_not_running'
      | 'harness_session_id_missing'
      | 'harness_mismatch'
      | 'active_process_mismatch',
    message: string,
  ) {
    super(message);
  }
}

export const AgentSessionService = Context.GenericTag<AgentSessionService>(
  'isagi/AgentSessionService',
);

export const AgentSessionServiceLive = Layer.effect(
  AgentSessionService,
  Effect.gen(function* () {
    const repository = yield* AgentSessionRepository;
    const surfaces = yield* SurfaceRepository;
    const pty = yield* PtyService;
    const harnesses = yield* HarnessAdapterRegistry;
    const eventBus = yield* InternalRuntimeEventBus;
    const restoreLocks = new Map<number, Promise<void>>();

    const publishChanged = (agentSessionId: number) =>
      eventBus.publish({ type: 'agent_session_changed', agentSessionId });

    const launchProcessForSession = (session: AgentSessionRow) =>
      Effect.gen(function* () {
        const launch = yield* agentLaunchEnvelope(harnesses, session);
        const process = yield* pty.launch(launch);
        yield* repository.setActivePtyProcess({
          agentSessionId: session.id,
          ptyProcessId: process.ptyProcessId,
        });
        yield* publishChanged(session.id);
        return process.ptyProcessId;
      });

    const ensureActivePtyProcess = (agentSessionId: number) =>
      withSessionLock(
        restoreLocks,
        agentSessionId,
        Effect.gen(function* () {
          const session = yield* findAgentSessionOrFail(repository, agentSessionId);
          const process = session.activePtyProcess;
          if (session.activePtyProcessId && process?.status === 'running') {
            return session.activePtyProcessId;
          }
          if (session.activePtyProcessId && process?.status === 'starting') {
            return session.activePtyProcessId;
          }
          if (!session.harnessSessionId) {
            return yield* Effect.fail(
              new AgentSessionError(
                'harness_session_id_missing',
                `Agent session ${agentSessionId} cannot be restored because no harness session id has been captured.`,
              ),
            );
          }
          return yield* launchProcessForSession(session);
        }),
      );

    return {
      launch: (input) =>
        Effect.gen(function* () {
          const surface = yield* surfaces.createSinglePaneSurface({
            worktreeId: input.worktreeId,
            kind: 'agent',
            titleBase: titleForHarness(input.harness),
          });
          const agentSessionId = yield* repository.create({
            paneId: surface.paneId,
            worktreeId: input.worktreeId,
            harness: input.harness,
            cwd: surface.cwd,
          });
          const launch = yield* harnesses.buildLaunch({
            agentSessionId,
            harness: input.harness,
            cwd: surface.cwd,
            latestHarnessSessionId: null,
          });
          const process = yield* pty.launch(launch);
          yield* repository.setActivePtyProcess({
            agentSessionId,
            ptyProcessId: process.ptyProcessId,
          });
          yield* publishChanged(agentSessionId);
          return {
            worktreeId: input.worktreeId,
            surfaceId: surface.surfaceId,
            paneId: surface.paneId,
            agentSessionId,
          } satisfies LaunchAgentSessionOutput;
        }),
      ensureActivePtyProcess,
      activePtyProcessId: (agentSessionId) =>
        Effect.gen(function* () {
          const session = yield* findAgentSessionOrFail(repository, agentSessionId);
          if (!session.activePtyProcessId || !session.activePtyProcess)
            return yield* Effect.fail(
              new AgentSessionError(
                'active_process_missing',
                `Agent session ${agentSessionId} has no active PTY process.`,
              ),
            );
          if (session.activePtyProcess.status !== 'running')
            return yield* Effect.fail(
              new AgentSessionError(
                'active_process_not_running',
                `Agent session ${agentSessionId} active process is not running.`,
              ),
            );
          return session.activePtyProcessId;
        }),
      recordHarnessSessionObservation: (input) =>
        Effect.gen(function* () {
          const session = yield* findAgentSessionOrFail(repository, input.agentSessionId);
          if (session.harness !== input.harness) {
            return yield* Effect.fail(
              new AgentSessionError(
                'harness_mismatch',
                `Agent session ${input.agentSessionId} uses ${session.harness}, not ${input.harness}.`,
              ),
            );
          }
          if (session.activePtyProcessId !== input.ptyProcessId) {
            return yield* Effect.fail(
              new AgentSessionError(
                'active_process_mismatch',
                `Harness event for PTY process ${input.ptyProcessId} does not match agent session ${input.agentSessionId}.`,
              ),
            );
          }
          yield* repository.recordHarnessSessionObservation({
            agentSessionId: input.agentSessionId,
            harnessSessionId: input.harnessSessionId,
            harnessSessionRefJson: JSON.stringify({ source: input.source }),
          });
          yield* publishChanged(input.agentSessionId);
        }),
    } satisfies AgentSessionService;
  }),
);

function findAgentSessionOrFail(
  repository: import('./agent-sessions.repository.js').AgentSessionRepositoryService,
  agentSessionId: number,
) {
  return Effect.gen(function* () {
    const session = yield* repository.find(agentSessionId);
    if (!session) {
      return yield* Effect.fail(
        new AgentSessionError(
          'session_not_found',
          `Agent session ${agentSessionId} was not found.`,
        ),
      );
    }
    return session;
  });
}

function agentLaunchEnvelope(
  harnesses: import('../harness-adapters/index.js').HarnessAdapterRegistryService,
  session: AgentSessionRow,
) {
  return harnesses.buildLaunch({
    agentSessionId: session.id,
    harness: session.harness,
    cwd: session.cwd,
    latestHarnessSessionId: session.harnessSessionId,
  });
}

function withSessionLock<A, E>(
  locks: Map<number, Promise<void>>,
  sessionId: number,
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, E> {
  return Effect.acquireUseRelease(
    acquireSessionLock(locks, sessionId),
    () => effect,
    (release) => Effect.sync(release),
  );
}

function acquireSessionLock(locks: Map<number, Promise<void>>, sessionId: number) {
  return Effect.promise(() => {
    const previous = locks.get(sessionId) ?? Promise.resolve();
    let releaseCurrent: () => void = () => {};
    const current = previous
      .catch(() => {})
      .then(
        () =>
          new Promise<void>((resolve) => {
            releaseCurrent = resolve;
          }),
      );
    locks.set(sessionId, current);
    return previous
      .catch(() => {})
      .then(() => () => {
        releaseCurrent();
        if (locks.get(sessionId) === current) {
          locks.delete(sessionId);
        }
      });
  });
}

export type { AgentSessionRepositoryService } from './agent-sessions.repository.js';
