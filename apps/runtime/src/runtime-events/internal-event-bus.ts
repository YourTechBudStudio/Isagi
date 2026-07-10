import { Context, Effect, Layer, Queue } from 'effect';

import type { SessionStatus, SurfaceChangedEvent, WorkflowEvent } from '@isagi/contracts';

type SurfaceChangedPayload = SurfaceChangedEvent['payload'];

export type InternalRuntimeEvent =
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
      readonly type: 'surface_changed';
      readonly payload: SurfaceChangedPayload;
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
      readonly type: 'headless_op_completed';
      readonly runId: number;
      readonly opId: string;
    }
  | {
      readonly type: 'workflow_run_terminal';
      readonly runId: number;
      readonly status: 'done' | 'failed';
    }
  | {
      // Internal repository→projection trigger: "a run row was touched, recompute its
      // root summary". Distinct from the public `workflow_run_changed` contract event
      // (payload = full WorkflowRunSummary) the projection emits on the public bus.
      readonly type: 'workflow_run_touched';
      readonly runId: number;
      readonly rootRunId: number | null;
      readonly surfaceId: number | null;
    }
  | {
      readonly type: 'workflow_run_recompute_requested';
      readonly rootRunId: number;
      readonly surfaceId: number | null;
    }
  | {
      readonly type: 'workflow_event_appended';
      readonly surfaceId: number | null;
      readonly rootRunId: number | null;
      readonly runId: number;
      readonly event: WorkflowEvent;
    };

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
