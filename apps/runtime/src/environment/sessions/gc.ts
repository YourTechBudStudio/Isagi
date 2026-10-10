import { Cause, Clock, Context, Duration, Effect, Layer } from 'effect';

import { AgentSessionArtifacts } from '../../harnesses/index.js';
import { diagnosticPhase } from '../../platform/diagnostics/index.js';
import { InternalEvents } from '../../platform/events/index.js';
import { runPeriodically } from '../../platform/fibers/index.js';
import type { DatabaseError } from '../../platform/persistence/index.js';
import { AgentSessionRepository } from '../agent-sessions/repository.js';
import { TerminalSessionRepository } from '../terminal-sessions/repository.js';
import { SessionLifecycle } from './lifecycle.js';

/**
 * The session GC's timings. Production uses the defaults; tests provide other values with
 * `Layer.succeed(SessionGcSettings, {...})`.
 */
export interface SessionGcTimings {
  /** How often a collection pass runs. The first pass runs one interval after startup. */
  readonly interval: Duration.Duration;
  /** How long an unplaced session row must have been untouched before it is collected. */
  readonly orphanGrace: Duration.Duration;
  /**
   * How old a session folder that no row references must be before it is collected. A folder whose harness is still
   * appending to a ledger stays young, so the grace only has to absorb the mark/list race and a harness that outlives
   * its row.
   */
  readonly orphanFolderGrace: Duration.Duration;
}

export const SessionGcSettings = Context.Reference<SessionGcTimings>(
  'isagi/runtime/environment/SessionGcSettings',
  {
    defaultValue: () => ({
      interval: Duration.minutes(1),
      orphanGrace: Duration.minutes(1),
      orphanFolderGrace: Duration.hours(1),
    }),
  },
);

/** The services one collection pass reads. */
type SessionGcServices =
  | AgentSessionArtifacts
  | AgentSessionRepository
  | InternalEvents
  | SessionLifecycle
  | TerminalSessionRepository;

/**
 * Deletes agent and terminal session rows that no pane holds and that have been untouched for the orphan grace,
 * unless a client is still attached to them, and announces each deletion.
 */
const collectOrphanSessions = Effect.fn('SessionGc.collectOrphans')(function* () {
  const agents = yield* AgentSessionRepository;
  const terminals = yield* TerminalSessionRepository;
  const lifecycle = yield* SessionLifecycle;
  const events = yield* InternalEvents;
  const { orphanGrace } = yield* SessionGcSettings;
  const now = yield* Clock.currentTimeMillis;
  const cutoff = new Date(now - Duration.toMillis(orphanGrace)).toISOString();
  const [orphanAgents, orphanTerminals] = yield* Effect.all([
    agents.listOrphans({ updatedBefore: cutoff }),
    terminals.listOrphans({ updatedBefore: cutoff }),
  ]);

  for (const session of orphanAgents) {
    const key = { kind: 'agent_session' as const, sessionId: session.id };
    if (yield* lifecycle.hasActiveAttachment(key)) continue;
    yield* lifecycle.supersedeAttachment(key);
    yield* agents.delete(session.id);
    yield* events.publish({
      type: 'durable_session_deleted',
      identity: { kind: 'agent_session', sessionId: session.id, worktreeId: session.worktreeId },
    });
  }

  for (const session of orphanTerminals) {
    const key = { kind: 'terminal_session' as const, sessionId: session.id };
    if (yield* lifecycle.hasActiveAttachment(key)) continue;
    yield* lifecycle.supersedeAttachment(key);
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

/**
 * Deleting a session (directly or by cascade) removes its row only; its folder is reclaimed here. The live ids are
 * read before the folders are listed, so a session created in between keeps its folder through the folder grace.
 */
const collectOrphanAgentFolders = Effect.fn('SessionGc.collectOrphanAgentFolders')(function* () {
  const agents = yield* AgentSessionRepository;
  const artifacts = yield* AgentSessionArtifacts;
  const { orphanFolderGrace } = yield* SessionGcSettings;
  yield* diagnosticPhase(
    'session_gc.orphan_agent_folders',
    {},
    Effect.gen(function* () {
      const liveIds = yield* agents.listIds;
      yield* artifacts.collectOrphanFolders({
        liveIds,
        minAgeMs: Duration.toMillis(orphanFolderGrace),
        nowMs: yield* Clock.currentTimeMillis,
      });
    }),
  );
});

/**
 * One collection pass, the tick the session GC loop runs: orphan rows, then orphan agent folders. The phases fail
 * independently: each failure is logged as a `Warning` and the other phase still runs, and the loop runs the next pass
 * one interval later. The folder phase also survives defects (such as a rejected promise inside the collector).
 *
 * Exported for this module's tests only, not on the service and not from the module's `index.ts`: no caller can
 * trigger a collection.
 */
export const collectSessionGarbage: Effect.Effect<void, never, SessionGcServices> = Effect.gen(
  function* () {
    yield* collectOrphanSessions().pipe(
      Effect.catch((error) => Effect.logWarning('Orphan session GC failed', Cause.fail(error))),
    );
    yield* collectOrphanAgentFolders().pipe(
      // An interruption is not a failure of the phase: it stops the pass.
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning('Orphan agent folder GC failed', cause),
      ),
    );
  },
);

const make = Effect.gen(function* () {
  const services = yield* Effect.context<SessionGcServices>();
  const { interval } = yield* SessionGcSettings;
  // Owned by the layer scope: the loop is interrupted when the runtime shuts down.
  yield* runPeriodically('Session GC', interval, collectSessionGarbage);
  return SessionGc.of({
    collectOrphans: collectOrphanSessions().pipe(Effect.provideContext(services)),
  });
});

/**
 * Collects durable sessions nothing holds any more: unplaced, idle session rows every interval, and the agent session
 * folders whose rows are gone. The loop lives as long as the layer.
 */
export class SessionGc extends Context.Service<
  SessionGc,
  {
    readonly collectOrphans: Effect.Effect<void, DatabaseError>;
  }
>()('isagi/runtime/environment/SessionGc') {
  static readonly layerNoDeps = Layer.effect(SessionGc, make);
  static readonly layer = SessionGc.layerNoDeps.pipe(
    Layer.provide([
      AgentSessionArtifacts.layer,
      AgentSessionRepository.layer,
      InternalEvents.layer,
      SessionLifecycle.layer,
      TerminalSessionRepository.layer,
    ]),
  );
}
