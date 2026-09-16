import { Context, Effect, Layer, Queue } from 'effect';

import type { SessionStatus, SurfaceChangedEvent } from '@isagi/contracts';
import type { DurableSessionIdentity } from '@isagi/contracts';

type SurfaceChangedPayload = SurfaceChangedEvent['payload'];

export type InternalRuntimeEvent =
  | {
      readonly type: 'durable_session_deleted';
      readonly identity: DurableSessionIdentity;
    }
  | {
      readonly type: 'agent_session_changed';
      readonly agentSessionId: number;
    }
  | {
      // Private handoff after AgentSession owns the active-process pointer.
      // Generic PTY events remain owner-unaware.
      readonly type: 'agent_session_active_process_changed';
      readonly agentSessionId: number;
      readonly ptyProcessId: number;
    }
  | {
      readonly type: 'turn_started';
      readonly agentSessionId: number;
      readonly harnessSessionId: string;
      readonly seq: number;
      readonly recordedAt: string;
    }
  | {
      readonly type: 'turn_ended';
      readonly agentSessionId: number;
      readonly harnessSessionId: string;
      readonly seq: number;
      readonly recordedAt: string;
    }
  | {
      readonly type: 'turn_failed';
      readonly agentSessionId: number;
      readonly harnessSessionId: string;
      readonly seq: number | null;
      readonly recordedAt: string;
      readonly reason: 'session_died' | 'harness_error' | 'new_start_supersedes';
    }
  | {
      readonly type: 'worktree_activation_change';
      readonly previousWorktreeId: number | null;
      readonly nextWorktreeId: number | null;
      readonly cause: 'active_context_changed' | 'startup_restored';
    }
  | {
      readonly type: 'terminal_session_changed';
      readonly terminalSessionId: number;
    }
  | {
      // Identity only, deliberately. Every material transition of a durable
      // editor context normalizes to this one event — attempt changes, the
      // incarnation handoff, probe settlement, and the incarnation's terminal
      // PTY events alike — so a client that did not make the request still
      // learns that something changed and re-reads. Placement is not carried
      // because the editor domain does not know it; the projection layer adds
      // it when it turns this into a public event.
      readonly type: 'editor_context_changed';
      readonly editorContextId: number;
    }
  | {
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
       */
      readonly type: 'project_deleted';
      readonly projectId: number;
      readonly worktreeIds: readonly number[];
    }
  | {
      readonly type: 'pty_process_started';
      readonly ptyProcessId: number;
      readonly status: SessionStatus;
    }
  | {
      readonly type: 'pty_process_exited';
      readonly ptyProcessId: number;
      readonly status: SessionStatus;
      readonly exitCode: number | null;
      readonly signal: string | null;
    }
  | {
      readonly type: 'pty_process_failed';
      readonly ptyProcessId: number;
      readonly status: SessionStatus;
      readonly statusReason: string | null;
    }
  | {
      readonly type: 'pty_process_killed';
      readonly ptyProcessId: number;
      readonly status: SessionStatus;
      readonly statusReason: string | null;
    }
  | {
      readonly type: 'pty_foreground_command_started';
      readonly ptyProcessId: number;
    }
  | {
      readonly type: 'pty_foreground_command_ended';
      readonly ptyProcessId: number;
    }
  | {
      /**
       * A durable workflow operation reached a settled state.
       *
       * A wake-up, never the authority: the operation row is what says *what* it settled as, and a
       * dropped notification costs a delay rather than a fact, because the wait resolver's own
       * reconciliation reads the same rows. It replaces the old `headless_op_completed`, which named
       * only one of the four capabilities that can settle.
       */
      readonly type: 'workflow_operation_settled';
      readonly runId: number;
      readonly operationId: number;
      readonly operationKey: string;
    };

/*
 * `workflow_run_terminal`, `workflow_run_touched` and `workflow_run_recompute_requested` are gone
 * with the v1 projection that was their only consumer. The first was never published at all; the
 * other two carried `rootRunId`, a child-run identity this story retired. Nothing recomputes a
 * summary from a notification any more: a committed transition captures its own read model, and the
 * publisher drains it from the database. A variant nobody produces or consumes is not a seam kept
 * open for later — it is a claim about the runtime that is not true.
 */

export interface InternalRuntimeEventSubscription {
  readonly take: Effect.Effect<InternalRuntimeEvent>;
  readonly unsubscribe: Effect.Effect<void>;
}

export interface InternalRuntimeEventBusService {
  readonly publish: (event: InternalRuntimeEvent) => Effect.Effect<void>;
  readonly subscribe: (filter?: {
    readonly types?: readonly InternalRuntimeEvent['type'][] | undefined;
  }) => Effect.Effect<InternalRuntimeEventSubscription>;
}

export const InternalRuntimeEventBus = Context.GenericTag<InternalRuntimeEventBusService>(
  'isagi/InternalRuntimeEventBus',
);

export const InternalRuntimeEventBusLive = Layer.scoped(
  InternalRuntimeEventBus,
  Effect.gen(function* () {
    const subscribers = new Set<{
      readonly queue: Queue.Queue<InternalRuntimeEvent>;
      readonly types: ReadonlySet<InternalRuntimeEvent['type']> | null;
    }>();

    const service = {
      publish: (event) =>
        Effect.sync(() => {
          for (const subscriber of subscribers) {
            if (!subscriber.types || subscriber.types.has(event.type)) {
              subscriber.queue.unsafeOffer(event);
            }
          }
        }),
      subscribe: (filter) =>
        Queue.unbounded<InternalRuntimeEvent>().pipe(
          Effect.map((queue) => {
            const subscriber = {
              queue,
              types: filter?.types ? new Set(filter.types) : null,
            };
            subscribers.add(subscriber);
            return {
              take: queue.take,
              unsubscribe: Effect.sync(() => {
                subscribers.delete(subscriber);
              }).pipe(Effect.zipRight(queue.shutdown)),
            } satisfies InternalRuntimeEventSubscription;
          }),
        ),
    } satisfies InternalRuntimeEventBusService;

    return yield* Effect.acquireRelease(Effect.succeed(service), () =>
      Effect.gen(function* () {
        for (const subscriber of subscribers) {
          yield* subscriber.queue.shutdown;
        }
        subscribers.clear();
      }),
    );
  }),
);
