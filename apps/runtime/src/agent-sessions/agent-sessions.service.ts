import { Context, Effect, Layer } from 'effect';

import type { AgentHarness } from '@isagi/contracts';

import { HarnessControlPlane, type HarnessLaunchBlocked } from '../harness-control-plane/index.js';
import { DatabaseError } from '../persistence/index.js';
import { PtyService, type PtyLaunchError } from '../pty-processes/pty.service.js';
import { InternalRuntimeEventBus } from '../runtime-events/index.js';
import { SessionLifecycle } from '../session-lifecycle/index.js';
import type { AgentSessionRow } from '../surfaces/types.js';

/**
 * A losing insert in a keyed race, as SQLite reports it.
 *
 * Recognized narrowly by driver code rather than by message text, so an unrelated database fault is
 * never mistaken for a race and quietly retried.
 */
function isUniqueConstraintViolation(error: unknown): boolean {
  const cause = (error as { readonly cause?: unknown }).cause;
  const code = (cause as { readonly code?: unknown } | undefined)?.code;
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT_UNIQUE');
}
import { AgentSessionRepository } from './agent-sessions.repository.js';
import { HarnessAdapterRegistry } from './harness/index.js';
import { HarnessAdapterError, type HarnessLaunchOptions } from './harness/types.js';

export interface AgentSessionService {
  readonly startFresh: (input: {
    readonly worktreeId: number;
    readonly harness: AgentHarness;
    readonly cwd: string;
    /** Names the session this call intends to create, so a re-entry after a crash can adopt it. */
    readonly creationKey?: string | undefined;
  }) => Effect.Effect<
    { readonly agentSessionId: number },
    DatabaseError | HarnessLaunchBlocked | AgentSessionError
  >;
  readonly get: (
    agentSessionId: number,
  ) => Effect.Effect<AgentSessionRow, DatabaseError | AgentSessionError>;
  readonly ensureActivePtyProcess: (
    agentSessionId: number,
    options?: AgentSessionEnsureActiveOptions,
  ) => Effect.Effect<
    number,
    DatabaseError | AgentSessionError | PtyLaunchError | HarnessAdapterError | HarnessLaunchBlocked
  >;
  readonly activePtyProcessId: (
    agentSessionId: number,
  ) => Effect.Effect<number, DatabaseError | AgentSessionError>;
}

export interface AgentSessionEnsureActiveOptions extends HarnessLaunchOptions {
  readonly replaceEphemeralProcess?: boolean | undefined;
}

export class AgentSessionError extends Error {
  readonly _tag = 'AgentSessionError';
  constructor(
    readonly code:
      | 'session_not_found'
      | 'active_process_missing'
      | 'active_process_not_running'
      | 'harness_metadata_missing'
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
    const controlPlane = yield* HarnessControlPlane;

    const publishChanged = (agentSessionId: number) =>
      eventBus.publish({ type: 'agent_session_changed', agentSessionId });

    const launchProcessForSession = (session: AgentSessionRow, options?: HarnessLaunchOptions) =>
      Effect.gen(function* () {
        yield* controlPlane.assertCanCreateProcess(session.harness);
        const launch = yield* agentLaunchEnvelope(harnesses, session, options);
        const process = yield* pty.launch(launch);
        yield* repository.setActivePtyProcess({
          agentSessionId: session.id,
          ptyProcessId: process.ptyProcessId,
        });
        yield* eventBus.publish({
          type: 'agent_session_active_process_changed',
          agentSessionId: session.id,
          ptyProcessId: process.ptyProcessId,
        });
        return process.ptyProcessId;
      });

    const ensureActivePtyProcess = (
      agentSessionId: number,
      options?: AgentSessionEnsureActiveOptions,
    ) =>
      lifecycle.withRestoreLock(
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

    return {
      startFresh: (input) =>
        Effect.gen(function* () {
          yield* controlPlane.assertCanCreateProcess(input.harness);
          // Idempotent completion, not idempotent creation: a keyed call that finds its own
          // session returns it rather than starting a second agent in the person's worktree.
          const creationKey = input.creationKey;
          const adopt = (session: AgentSessionRow) =>
            Effect.gen(function* () {
              // Every fact this call supplied is compared, not just the harness. `cwd` is derived
              // from the worktree on the compound path, but this is a public owner API that accepts
              // it independently, so a key reused against a different directory is a different
              // intent and must not silently adopt.
              if (
                session.harness !== input.harness ||
                session.worktreeId !== input.worktreeId ||
                session.cwd !== input.cwd
              ) {
                return yield* Effect.fail(
                  new AgentSessionError(
                    'harness_mismatch',
                    `Creation key ${creationKey} already names an agent session that does not match this request.`,
                  ),
                );
              }
              return { agentSessionId: session.id };
            });

          const existing = creationKey ? yield* repository.findByCreationKey(creationKey) : null;
          if (existing) return yield* adopt(existing);

          const created = yield* repository
            .create({
              worktreeId: input.worktreeId,
              harness: input.harness,
              cwd: input.cwd,
              ...(creationKey === undefined ? {} : { creationKey }),
            })
            .pipe(
              Effect.map((agentSessionId) => ({ agentSessionId, isNew: true })),
              // Reading and then inserting is not atomic: two callers can both observe `absent`, and
              // exactly one wins the unique index. Losing that race is convergence, not failure —
              // the winner is the session this key names — so the conflict is a signal to re-read
              // and validate rather than an error to surface. Without this, "safely converges under
              // concurrent calls" would hold only because nothing ever raced.
              Effect.catchIf(
                (error) => creationKey !== undefined && isUniqueConstraintViolation(error),
                () =>
                  Effect.gen(function* () {
                    const winner = yield* repository.findByCreationKey(creationKey!);
                    if (!winner) return yield* Effect.die('keyed session vanished after conflict');
                    return { ...(yield* adopt(winner)), isNew: false };
                  }),
              ),
            );

          if (created.isNew) yield* publishChanged(created.agentSessionId);
          return { agentSessionId: created.agentSessionId };
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
        'harness_metadata_missing',
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

export type { AgentSessionRepositoryService } from './agent-sessions.repository.js';
