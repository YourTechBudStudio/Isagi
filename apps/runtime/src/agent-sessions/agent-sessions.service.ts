import { Context, Effect, Layer } from 'effect';

import type { AgentHarness } from '@isagi/contracts';

import { HarnessAdapterError, HarnessAdapterRegistry } from '../harness-adapters/index.js';
import { DatabaseError } from '../persistence/index.js';
import { PtyService, type PtyLaunchError } from '../pty-processes/pty.service.js';
import { InternalRuntimeEventBus } from '../runtime-events/index.js';
import { SessionLifecycle } from '../session-lifecycle/index.js';
import type { AgentSessionRow } from '../surfaces/types.js';
import { AgentSessionRepository } from './agent-sessions.repository.js';

export interface AgentSessionService {
  readonly startFresh: (input: {
    readonly worktreeId: number;
    readonly harness: AgentHarness;
    readonly cwd: string;
  }) => Effect.Effect<{ readonly agentSessionId: number }, DatabaseError>;
  readonly get: (
    agentSessionId: number,
  ) => Effect.Effect<AgentSessionRow, DatabaseError | AgentSessionError>;
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
    const pty = yield* PtyService;
    const harnesses = yield* HarnessAdapterRegistry;
    const eventBus = yield* InternalRuntimeEventBus;
    const lifecycle = yield* SessionLifecycle;

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
      lifecycle.withRestoreLock(
        { kind: 'agent_session', sessionId: agentSessionId },
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
      startFresh: (input) =>
        Effect.gen(function* () {
          const agentSessionId = yield* repository.create({
            worktreeId: input.worktreeId,
            harness: input.harness,
            cwd: input.cwd,
          });
          yield* publishChanged(agentSessionId);
          return { agentSessionId };
        }),
      get: (agentSessionId) => findAgentSessionOrFail(repository, agentSessionId),
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

export type { AgentSessionRepositoryService } from './agent-sessions.repository.js';
