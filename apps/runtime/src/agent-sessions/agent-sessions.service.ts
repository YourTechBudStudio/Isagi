import { Context, Effect, Layer } from 'effect';

import type { AgentHarness } from '@isagi/contracts';

import { DatabaseError } from '../persistence/index.js';
import { PtyService, type PtyLaunchError } from '../pty-processes/pty.service.js';
import { InternalRuntimeEventBus } from '../runtime-events/index.js';
import { SessionLifecycle } from '../session-lifecycle/index.js';
import type { AgentSessionRow } from '../surfaces/types.js';
import { AgentSessionRepository } from './agent-sessions.repository.js';
import { HarnessAdapterRegistry } from './harness/index.js';
import { HarnessAdapterError } from './harness/types.js';

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
    options?: { readonly model?: string | undefined; readonly effort?: string | undefined },
  ) => Effect.Effect<
    number,
    DatabaseError | AgentSessionError | PtyLaunchError | HarnessAdapterError
  >;
  readonly activePtyProcessId: (
    agentSessionId: number,
  ) => Effect.Effect<number, DatabaseError | AgentSessionError>;
}

export class AgentSessionError extends Error {
  readonly _tag = 'AgentSessionError';
  constructor(
    readonly code:
      | 'session_not_found'
      | 'active_process_missing'
      | 'active_process_not_running'
      | 'harness_session_id_missing'
      | 'harness_metadata_invalid'
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

    const launchProcessForSession = (
      session: AgentSessionRow,
      options?: { readonly model?: string | undefined; readonly effort?: string | undefined },
    ) =>
      Effect.gen(function* () {
        console.info('[runtime] Agent session launch requested', {
          agentSessionId: session.id,
          harness: session.harness,
          cwd: session.cwd,
          latestHarnessSessionId: session.harnessSessionId,
          previousPtyProcessId: session.activePtyProcessId,
          previousPtyProcessStatus: session.activePtyProcess?.status ?? null,
          previousPtyProcessStatusReason: session.activePtyProcess?.statusReason ?? null,
        });
        const launch = yield* agentLaunchEnvelope(harnesses, session, options);
        console.info('[runtime] Agent session launch envelope built', {
          agentSessionId: session.id,
          harness: session.harness,
          command: launch.command,
          args: launch.args,
          cwd: launch.cwd,
          injectsProcessEnv: Boolean(launch.envForProcess),
        });
        const process = yield* pty.launch(launch);
        yield* repository.setActivePtyProcess({
          agentSessionId: session.id,
          ptyProcessId: process.ptyProcessId,
        });
        console.info('[runtime] Agent session active PTY process set', {
          agentSessionId: session.id,
          ptyProcessId: process.ptyProcessId,
          harness: session.harness,
        });
        yield* publishChanged(session.id);
        return process.ptyProcessId;
      });

    const ensureActivePtyProcess = (
      agentSessionId: number,
      options?: { readonly model?: string | undefined; readonly effort?: string | undefined },
    ) =>
      lifecycle.withRestoreLock(
        { kind: 'agent_session', sessionId: agentSessionId },
        Effect.gen(function* () {
          const session = yield* findAgentSessionOrFail(repository, agentSessionId);
          yield* validateHarnessMetadata(session);
          const process = session.activePtyProcess;
          if (session.activePtyProcessId && process?.status === 'running') {
            console.info('[runtime] Agent session attach reusing running PTY process', {
              agentSessionId,
              ptyProcessId: session.activePtyProcessId,
              harness: session.harness,
            });
            return session.activePtyProcessId;
          }
          if (session.activePtyProcessId && process?.status === 'starting') {
            console.info('[runtime] Agent session attach reusing starting PTY process', {
              agentSessionId,
              ptyProcessId: session.activePtyProcessId,
              harness: session.harness,
            });
            return session.activePtyProcessId;
          }
          if (!session.activePtyProcessId) {
            console.info('[runtime] Agent session attach launching fresh PTY process', {
              agentSessionId,
              harness: session.harness,
              cwd: session.cwd,
            });
            return yield* launchProcessForSession(session, options);
          }
          if (!session.harnessSessionId) {
            console.warn(
              '[runtime] Agent session restoration blocked: missing harness session id',
              {
                agentSessionId,
                harness: session.harness,
                activePtyProcessId: session.activePtyProcessId,
                activePtyProcessStatus: process?.status ?? null,
                activePtyProcessStatusReason: process?.statusReason ?? null,
                activePtyProcessExitCode: process?.exitCode ?? null,
                activePtyProcessSignal: process?.signal ?? null,
              },
            );
            return yield* Effect.fail(
              new AgentSessionError(
                'harness_session_id_missing',
                `Agent session ${agentSessionId} cannot be restored because no harness session id has been captured.`,
              ),
            );
          }
          console.info('[runtime] Agent session attach launching resume PTY process', {
            agentSessionId,
            harness: session.harness,
            latestHarnessSessionId: session.harnessSessionId,
            previousPtyProcessId: session.activePtyProcessId,
            previousPtyProcessStatus: process?.status ?? null,
            previousPtyProcessStatusReason: process?.statusReason ?? null,
          });
          return yield* launchProcessForSession(session, options);
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

function validateHarnessMetadata(session: AgentSessionRow) {
  if (session.harnessMetadataStatus === 'missing') {
    console.warn('[runtime] Agent session restoration blocked: missing harness metadata', {
      agentSessionId: session.id,
      harness: session.harness,
      diagnostic: session.harnessMetadataDiagnostic,
    });
    return Effect.fail(
      new AgentSessionError(
        'harness_session_id_missing',
        `Agent session ${session.id} cannot be restored because harness metadata is missing.`,
      ),
    );
  }
  if (session.harnessMetadataStatus === 'invalid') {
    console.warn('[runtime] Agent session restoration blocked: invalid harness metadata', {
      agentSessionId: session.id,
      harness: session.harness,
      diagnostic: session.harnessMetadataDiagnostic,
    });
    return Effect.fail(
      new AgentSessionError(
        'harness_metadata_invalid',
        `Agent session ${session.id} cannot be restored because harness metadata is invalid.`,
      ),
    );
  }
  return Effect.void;
}

function agentLaunchEnvelope(
  harnesses: import('./harness/index.js').HarnessAdapterRegistryService,
  session: AgentSessionRow,
  options?: { readonly model?: string | undefined; readonly effort?: string | undefined },
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

export type { AgentSessionRepositoryService } from './agent-sessions.repository.js';
