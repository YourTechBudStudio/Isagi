import type { QueryClient } from '@tanstack/react-query';

import type {
  GetWorkflowRunOutput,
  ListWorkflowEventsOutput,
  WorkflowEventDto,
  WorkflowRunSummary,
} from '@isagi/contracts';

import {
  workflowAttachedRunsQueryKey,
  workflowCheckpointListQueryKey,
  workflowEventsQueryKey,
  workflowExecutionQueryKey,
  workflowRunQueryKey,
} from '../query-keys.js';
import { replaceAttached, upsertAttached, type AttachedRuns } from './attached.js';
import { subscribeToWorkflowSignals, type WorkflowSignal } from './signals.js';

/**
 * How long a burst of events for one row is collected before that row is refetched once.
 *
 * A running node appends several events within milliseconds (started, operation started and
 * finished, waiting), and each names the same run. One refetch per burst is enough.
 */
export const workflowRefetchDelayMs = 250;

/**
 * Keeps the workflow caches in step with the runtime socket. Mounted once per session.
 *
 * The whole live protocol is: an event arrives, it is appended to its run's event list, and the run
 * (and the execution it names, if any) is refetched. A changed summary replaces the cached one. The
 * latest write wins; nothing compares revisions or timestamps, so a slow refetch can briefly show an
 * older summary until the next event or refetch corrects it.
 */
export class WorkflowLiveSync {
  private readonly queryClient: QueryClient;
  private readonly runtimeIdentity: string;
  private readonly delayMs: number;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubscribe: (() => void) | null = null;

  constructor(options: {
    readonly queryClient: QueryClient;
    readonly runtimeIdentity: string;
    readonly delayMs?: number | undefined;
  }) {
    this.queryClient = options.queryClient;
    this.runtimeIdentity = options.runtimeIdentity;
    this.delayMs = options.delayMs ?? workflowRefetchDelayMs;
  }

  start() {
    if (this.unsubscribe) return;
    this.unsubscribe = subscribeToWorkflowSignals((signal) => this.receive(signal));
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  receive(signal: WorkflowSignal) {
    switch (signal.type) {
      case 'snapshot':
        this.queryClient.setQueryData<AttachedRuns>(this.attachedKey(), () =>
          replaceAttached(signal.summaries),
        );
        break;
      case 'run_changed':
        this.applySummary(signal.summary);
        break;
      case 'run_event':
        this.applyEvent(signal.event);
        break;
      case 'connected':
        // A reconnect cannot prove nothing was missed while the socket was down, so every open run
        // view re-reads. Event ids are global across runs, so a gap in one run's list cannot be
        // detected; the event list is re-read from the beginning and merged.
        // Structures and saved checkpoints are immutable, and the snapshot refreshes attached runs.
        void this.queryClient.invalidateQueries({
          queryKey: ['workflows', this.runtimeIdentity],
          predicate: (query) => liveKinds.has(String(query.queryKey[2])),
        });
        break;
      case 'disconnected':
        break;
    }
  }

  private applySummary(summary: WorkflowRunSummary) {
    this.queryClient.setQueryData<AttachedRuns>(this.attachedKey(), (current) =>
      upsertAttached(current ?? [], summary),
    );
    const runKey = workflowRunQueryKey(this.runtimeIdentity, summary.runId);
    if (this.queryClient.getQueryState(runKey)?.status === 'error') {
      // Writing the summary would clear the failed read's error while the tree beside it is still
      // the one that failed to refresh. A successful re-read is what clears it.
      this.refetchSoon(runKey);
      return;
    }
    this.queryClient.setQueryData<GetWorkflowRunOutput>(runKey, (current) =>
      current === undefined ? current : { ...current, run: summary },
    );
  }

  private applyEvent(event: WorkflowEventDto) {
    const eventsKey = workflowEventsQueryKey(this.runtimeIdentity, event.runId);
    const state = this.queryClient.getQueryState(eventsKey);
    if (state?.fetchStatus === 'fetching') {
      // A read is in flight and may already have passed this event, so it waits for that read.
      holdForRead(eventsKey, event);
    } else if (state?.status === 'error') {
      // The last read failed, so what is held is incomplete. Appending would clear that error
      // without recovering what was missed; a full re-read either succeeds or keeps the warning.
      holdForRead(eventsKey, event);
      this.refetchSoon(eventsKey);
    } else if (state?.data === undefined) {
      // Nothing holds this run's events; the next read starts from the beginning and includes it.
    } else {
      this.queryClient.setQueryData<readonly WorkflowEventDto[]>(eventsKey, (current) =>
        mergeEvents(current ?? [], [event]),
      );
    }

    this.refetchSoon(workflowRunQueryKey(this.runtimeIdentity, event.runId));
    if (event.executionId !== null) {
      this.refetchSoon(workflowExecutionQueryKey(this.runtimeIdentity, event.executionId));
    }
    if (event.kind === 'checkpoint_captured') {
      this.refetchSoon(workflowCheckpointListQueryKey(this.runtimeIdentity, event.runId));
    }
  }

  /** One trailing refetch per key per burst. Only a query someone is looking at is refetched. */
  private refetchSoon(queryKey: readonly unknown[]) {
    const id = JSON.stringify(queryKey);
    if (this.timers.has(id)) return;
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        void this.queryClient.invalidateQueries({ queryKey, exact: true });
      }, this.delayMs),
    );
  }

  private attachedKey() {
    return workflowAttachedRunsQueryKey(this.runtimeIdentity);
  }
}

/** The query kinds whose data changes while a run is live. */
const liveKinds = new Set(['run', 'events', 'execution', 'checkpoints']);

/** Events by id, each once. Both sides are already in id order in practice; this does not rely on it. */
export function mergeEvents(
  current: readonly WorkflowEventDto[],
  incoming: readonly WorkflowEventDto[],
): readonly WorkflowEventDto[] {
  const last = current.at(-1)?.eventId ?? 0;
  // The common case: a pushed event newer than everything held.
  if (incoming.every((event) => event.eventId > last) && isAscending(incoming)) {
    return incoming.length === 0 ? current : [...current, ...incoming];
  }
  const byId = new Map<number, WorkflowEventDto>();
  for (const event of current) byId.set(event.eventId, event);
  for (const event of incoming) byId.set(event.eventId, event);
  return [...byId.values()].sort((left, right) => left.eventId - right.eventId);
}

function isAscending(events: readonly WorkflowEventDto[]): boolean {
  for (let index = 1; index < events.length; index += 1) {
    if (events[index]!.eventId <= events[index - 1]!.eventId) return false;
  }
  return true;
}

/**
 * Events pushed for a run whose first read was still in flight, keyed by that read's query key.
 * The read merges and clears them when it finishes, so a push that raced it is not lost.
 */
const heldForRead = new Map<string, WorkflowEventDto[]>();

function holdForRead(queryKey: readonly unknown[], event: WorkflowEventDto) {
  const id = JSON.stringify(queryKey);
  heldForRead.set(id, [...(heldForRead.get(id) ?? []), event]);
}

function takeHeldForRead(queryKey: readonly unknown[]): readonly WorkflowEventDto[] {
  const id = JSON.stringify(queryKey);
  const held = heldForRead.get(id) ?? [];
  heldForRead.delete(id);
  return held;
}

/**
 * A run's whole event log, read forward from the beginning in pages.
 *
 * Whatever is already cached, and whatever was pushed while the read was in flight, is merged in
 * by id rather than overwritten.
 */
export async function loadWorkflowEvents(input: {
  readonly queryClient: QueryClient;
  readonly runtimeIdentity: string | null;
  readonly runId: number;
  readonly list: (cursor: number | null) => Promise<ListWorkflowEventsOutput>;
  readonly signal?: AbortSignal | undefined;
}): Promise<readonly WorkflowEventDto[]> {
  const key = workflowEventsQueryKey(input.runtimeIdentity, input.runId);
  const fetched: WorkflowEventDto[] = [];
  let cursor: number | null = null;
  for (;;) {
    const page = await input.list(cursor);
    fetched.push(...page.items);
    input.signal?.throwIfAborted();
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  const cached = input.queryClient.getQueryData<readonly WorkflowEventDto[]>(key) ?? [];
  return mergeEvents(mergeEvents(cached, fetched), takeHeldForRead(key));
}
