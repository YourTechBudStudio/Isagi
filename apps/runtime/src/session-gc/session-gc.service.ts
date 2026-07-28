import { Context, Effect, Layer } from 'effect';

import { AgentSessionRepository } from '../agent-sessions/index.js';
import type { DatabaseError } from '../persistence/index.js';
import { InternalRuntimeEventBus } from '../runtime-events/index.js';
import { SessionLifecycle } from '../session-lifecycle/index.js';
import { TerminalSessionRepository } from '../terminal-sessions/index.js';

const orphanGraceMs = 60_000;
const orphanGcIntervalMs = 60_000;

export interface SessionGcService {
  readonly collectOrphans: Effect.Effect<void, DatabaseError>;
}

export const SessionGc = Context.GenericTag<SessionGcService>('isagi/SessionGc');

export const SessionGcLive = Layer.scoped(
  SessionGc,
  Effect.gen(function* () {
    const agents = yield* AgentSessionRepository;
    const terminals = yield* TerminalSessionRepository;
    const lifecycle = yield* SessionLifecycle;
    const events = yield* InternalRuntimeEventBus;

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

    const service = { collectOrphans } satisfies SessionGcService;

    const timer = setInterval(() => {
      void Effect.runPromise(
        service.collectOrphans.pipe(
          Effect.catchAll((error) =>
            Effect.sync(() => console.warn('[runtime] orphan session GC failed', error)),
          ),
        ),
      );
    }, orphanGcIntervalMs);
    timer.unref();

    return yield* Effect.acquireRelease(Effect.succeed(service), () =>
      Effect.sync(() => clearInterval(timer)),
    );
  }),
);
