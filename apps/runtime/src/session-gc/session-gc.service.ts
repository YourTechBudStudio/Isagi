import { Cause, Context, Effect, Layer } from 'effect';

import {
  AgentSessionArtifacts,
  AgentSessionRepository,
  type AgentSessionArtifactsService,
  type AgentSessionRepositoryService,
} from '../agent-sessions/index.js';
import { diagnosticPhase } from '../diagnostics/phase.js';
import type { DatabaseError } from '../persistence/index.js';
import {
  InternalRuntimeEventBus,
  type InternalRuntimeEventBusService,
} from '../runtime-events/index.js';
import { SessionLifecycle, type SessionLifecycleService } from '../session-lifecycle/index.js';
import {
  TerminalSessionRepository,
  type TerminalSessionRepositoryService,
} from '../terminal-sessions/index.js';

const orphanGraceMs = 60_000;
const orphanGcIntervalMs = 60_000;
// Session folders no row references wait this long before collection. A folder
// whose harness is still appending to a ledger stays young, so the grace only
// has to absorb the mark/list race and a harness that outlives its row.
const orphanAgentFolderGraceMs = 60 * 60_000;

export interface SessionGcService {
  readonly collectOrphans: Effect.Effect<void, DatabaseError>;
}

export const SessionGc = Context.GenericTag<SessionGcService>('isagi/SessionGc');

export interface SessionGcDependencies {
  readonly agents: AgentSessionRepositoryService;
  readonly terminals: TerminalSessionRepositoryService;
  readonly lifecycle: SessionLifecycleService;
  readonly events: InternalRuntimeEventBusService;
  readonly artifacts: AgentSessionArtifactsService;
}

/**
 * Builds the row collector and the timer tick. `tick` is what the timer runs and never fails; it is
 * exported for tests only and deliberately not on the service tag, so no caller can trigger a
 * collection.
 */
export function makeSessionGc({
  agents,
  terminals,
  lifecycle,
  events,
  artifacts,
}: SessionGcDependencies) {
  const collectOrphans = Effect.gen(function* () {
    const cutoff = new Date(Date.now() - orphanGraceMs).toISOString();
    const [orphanAgents, orphanTerminals] = yield* Effect.all([
      agents.listOrphans({ updatedBefore: cutoff }),
      terminals.listOrphans({ updatedBefore: cutoff }),
    ]);

    for (const session of orphanAgents) {
      const key = { kind: 'agent_session' as const, sessionId: session.id };
      if (yield* lifecycle.hasActiveAttachment(key)) continue;
      yield* lifecycle.supersedeAttachment(key).pipe(Effect.ignore);
      yield* agents.delete(session.id);
      yield* events.publish({
        type: 'durable_session_deleted',
        identity: {
          kind: 'agent_session',
          sessionId: session.id,
          worktreeId: session.worktreeId,
        },
      });
    }

    for (const session of orphanTerminals) {
      const key = { kind: 'terminal_session' as const, sessionId: session.id };
      if (yield* lifecycle.hasActiveAttachment(key)) continue;
      yield* lifecycle.supersedeAttachment(key).pipe(Effect.ignore);
      yield* terminals.delete(session.id);
      yield* events.publish({
        type: 'durable_session_deleted',
        identity: {
          kind: 'terminal_session',
          sessionId: session.id,
          worktreeId: session.worktreeId,
        },
      });
    }
  });

  // Deleting a session (directly or by cascade) removes its row only; its
  // folder is reclaimed here. The mark is read before the folders are listed.
  const collectOrphanAgentFolders = diagnosticPhase(
    'session_gc.orphan_agent_folders',
    {},
    Effect.gen(function* () {
      const liveIds = yield* agents.listIds;
      yield* artifacts.collectOrphanFolders({
        liveIds,
        minAgeMs: orphanAgentFolderGraceMs,
        nowMs: Date.now(),
      });
    }),
  );

  const tick: Effect.Effect<void> = Effect.gen(function* () {
    yield* collectOrphans.pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => console.warn('[runtime] orphan session GC failed', error)),
      ),
    );
    // catchAllCause, not catchAll: a defect here (such as a rejected promise)
    // must be logged and leave the next tick running.
    yield* collectOrphanAgentFolders.pipe(
      Effect.catchAllCause((cause) =>
        Effect.sync(() =>
          console.warn('[runtime] orphan agent folder GC failed', Cause.pretty(cause)),
        ),
      ),
    );
  });

  return { collectOrphans, tick };
}

export const SessionGcLive = Layer.scoped(
  SessionGc,
  Effect.gen(function* () {
    const gc = makeSessionGc({
      agents: yield* AgentSessionRepository,
      terminals: yield* TerminalSessionRepository,
      lifecycle: yield* SessionLifecycle,
      events: yield* InternalRuntimeEventBus,
      artifacts: yield* AgentSessionArtifacts,
    });
    const service = { collectOrphans: gc.collectOrphans } satisfies SessionGcService;

    const timer = setInterval(() => {
      void Effect.runPromise(gc.tick);
    }, orphanGcIntervalMs);
    timer.unref();

    return yield* Effect.acquireRelease(Effect.succeed(service), () =>
      Effect.sync(() => clearInterval(timer)),
    );
  }),
);
