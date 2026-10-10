import { Context, Effect, Layer, PubSub, Stream, type Scope } from 'effect';

import type { SessionStatus, SurfaceChangedEvent } from '@isagi/contracts';
import type { DurableSessionIdentity } from '@isagi/contracts';

type SurfaceChangedPayload = SurfaceChangedEvent['payload'];

/**
 * Every internal event, as one closed union. Modules use it to react after the fact to what another module did
 * without importing it. Each variant names its publishing and subscribing modules in a `publishers: …; subscribers: …`
 * line; a new variant, publisher or subscriber updates that line in the same change.
 */
export type InternalEvent =
  | {
      /** publishers: environment (session GC), workspace (cascade delete); subscribers: environment (projection). */
      readonly type: 'durable_session_deleted';
      readonly identity: DurableSessionIdentity;
    }
  | {
      /** publishers: environment, harnesses (observer); subscribers: environment (projection). */
      readonly type: 'agent_session_changed';
      readonly agentSessionId: number;
    }
  | {
      /**
       * Private handoff after AgentSession owns the active-process pointer.
       * Generic PTY events remain owner-unaware.
       *
       * publishers: environment; subscribers: harnesses (observer).
       */
      readonly type: 'agent_session_active_process_changed';
      readonly agentSessionId: number;
      readonly ptyProcessId: number;
    }
  | {
      /** publishers: harnesses (observer); subscribers: workflows. */
      readonly type: 'turn_started';
      readonly agentSessionId: number;
      readonly harnessSessionId: string;
      readonly seq: number;
      readonly recordedAt: string;
    }
  | {
      /** publishers: harnesses (observer); subscribers: workflows. */
      readonly type: 'turn_ended';
      readonly agentSessionId: number;
      readonly harnessSessionId: string;
      readonly seq: number;
      readonly recordedAt: string;
    }
  | {
      /** publishers: harnesses (observer); subscribers: workflows. */
      readonly type: 'turn_failed';
      readonly agentSessionId: number;
      readonly harnessSessionId: string;
      readonly seq: number | null;
      readonly recordedAt: string;
      readonly reason: 'session_died' | 'harness_error' | 'new_start_supersedes';
    }
  | {
      /** publishers: workspace (incl. `publishRestoredActivation`); subscribers: commands. */
      readonly type: 'worktree_activation_change';
      readonly previousWorktreeId: number | null;
      readonly nextWorktreeId: number | null;
      readonly cause: 'active_context_changed' | 'startup_restored';
    }
  | {
      /** publishers: environment; subscribers: environment (projection). */
      readonly type: 'terminal_session_changed';
      readonly terminalSessionId: number;
    }
  | {
      /**
       * Identity only, deliberately. Every material transition of a durable
       * editor context normalizes to this one event — attempt changes, the
       * incarnation handoff, probe settlement, and the incarnation's terminal
       * PTY events alike — so a client that did not make the request still
       * learns that something changed and re-reads. Placement is not carried
       * because the editor domain does not know it; the projection layer adds
       * it when it turns this into a public event.
       *
       * publishers: editor, environment; subscribers: environment (projection).
       */
      readonly type: 'editor_context_changed';
      readonly editorContextId: number;
    }
  | {
      /** publishers: environment; subscribers: environment (projection). */
      readonly type: 'surface_changed';
      readonly payload: SurfaceChangedPayload;
    }
  | {
      /**
       * A worktree row and everything cascading from it are gone.
       *
       * Published after the delete commits, like every other deletion notification here, which is
       * why a consumer cannot find affected work through anything that cascaded: workflow runs are
       * matched by their retained destination identity instead.
       *
       * publishers: workspace; subscribers: none (kept; asserted by workspace tests).
       */
      readonly type: 'worktree_deleted';
      readonly worktreeId: number;
      readonly projectId: number;
    }
  | {
      /**
       * A project and its worktrees are gone.
       *
       * `worktreeIds` is read **before** the cascade, because `worktrees.project_id` cascades from
       * `projects` and those rows cannot be enumerated afterwards.
       *
       * publishers: workspace; subscribers: none (kept; asserted by workspace tests).
       */
      readonly type: 'project_deleted';
      readonly projectId: number;
      readonly worktreeIds: readonly number[];
    }
  | {
      /** publishers: pty-processes; subscribers: editor, commands, harnesses (observer), workflows, environment (projection). */
      readonly type: 'pty_process_started';
      readonly ptyProcessId: number;
      readonly status: SessionStatus;
    }
  | {
      /** publishers: pty-processes; subscribers: editor, commands, harnesses (observer), workflows, environment (projection). */
      readonly type: 'pty_process_exited';
      readonly ptyProcessId: number;
      readonly status: SessionStatus;
      readonly exitCode: number | null;
      readonly signal: string | null;
    }
  | {
      /** publishers: pty-processes; subscribers: editor, commands, harnesses (observer), workflows, environment (projection). */
      readonly type: 'pty_process_failed';
      readonly ptyProcessId: number;
      readonly status: SessionStatus;
      readonly statusReason: string | null;
    }
  | {
      /** publishers: pty-processes; subscribers: editor, commands, harnesses (observer), workflows, environment (projection). */
      readonly type: 'pty_process_killed';
      readonly ptyProcessId: number;
      readonly status: SessionStatus;
      readonly statusReason: string | null;
    }
  | {
      /** publishers: pty-processes; subscribers: editor, commands, harnesses (observer), workflows, environment (projection). */
      readonly type: 'pty_foreground_command_started';
      readonly ptyProcessId: number;
    }
  | {
      /** publishers: pty-processes; subscribers: editor, commands, harnesses (observer), workflows, environment (projection). */
      readonly type: 'pty_foreground_command_ended';
      readonly ptyProcessId: number;
    };

/** The internal events whose `type` is one of `T`. */
export type InternalEventOf<T extends InternalEvent['type']> = Extract<
  InternalEvent,
  { readonly type: T }
>;

/**
 * The runtime's in-process event bus: one total order of internal events across every publisher.
 *
 * Built on an unbounded `PubSub`, so publishing never waits for a subscriber (a slow subscriber only grows its own
 * backlog, as with the per-subscriber queues this replaced) and publishing after the bus shut down is a no-op.
 */
export class InternalEvents extends Context.Service<
  InternalEvents,
  {
    readonly publish: (event: InternalEvent) => Effect.Effect<void>;
    /**
     * Subscribes now, in the caller's scope: every matching event published after this effect completes is delivered
     * to the returned stream, in publish order. The subscription ends when the scope closes (or the bus shuts down,
     * which ends the stream by interrupting its consumer).
     *
     * Consume it with `Stream.runForEach` in a fiber forked into the same scope. Never subscribe lazily (for example
     * `Stream.fromPubSub` inside the forked consumer): events published before that fiber first runs would be lost.
     */
    readonly subscribe: <const T extends InternalEvent['type']>(
      types: ReadonlyArray<T>,
    ) => Effect.Effect<Stream.Stream<InternalEventOf<T>>, never, Scope.Scope>;
  }
>()('isagi/runtime/platform/events/InternalEvents') {
  static readonly layer = Layer.effect(
    InternalEvents,
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<InternalEvent>();
      yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub));
      return InternalEvents.of({
        publish: (event) => PubSub.publish(pubsub, event).pipe(Effect.asVoid),
        subscribe: (types) =>
          PubSub.subscribe(pubsub).pipe(
            Effect.map((subscription) => {
              const wanted: ReadonlySet<InternalEvent['type']> = new Set(types);
              return Stream.fromSubscription(subscription).pipe(
                Stream.filter((event): event is InternalEventOf<(typeof types)[number]> =>
                  wanted.has(event.type),
                ),
              );
            }),
          ),
      });
    }),
  );
}
