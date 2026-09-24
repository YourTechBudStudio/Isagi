import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import type {
  AdvanceWorkflowInput,
  GetWorkflowStructureOutput,
  ListWorkflowCheckpointInventoryOutput,
  ListWorkflowCheckpointsOutput,
  ListWorkflowEventsOutput,
  ListWorkflowEvidenceOutput,
  StartWorkflowInput,
  WorkflowCheckpointInventoryEntry,
  WorkflowCheckpointSummaryDto,
  WorkflowLaunchOrigin,
  WorkflowEvidenceDto,
  WorkflowOperationDto,
  WorkflowRunSummary,
} from '@isagi/contracts';

import { runRuntimeEffect } from '../../runtime/run.js';
import {
  runtimeIdentityQueryKey,
  workflowAttachedRunsQueryKey,
  workflowCheckpointFileContentQueryKey,
  workflowCheckpointInventoryQueryKey,
  workflowCheckpointListQueryKey,
  workflowCheckpointQueryKey,
  workflowDescriptorsQueryKey,
  workflowLogQueryKey,
  workflowPayloadQueryKey,
  workflowRunStateQueryKey,
  workflowCurrentStructureQueryKey,
  workflowDescriptorQueryKey,
  workflowExecutionOperationsQueryKey,
  workflowEvidenceContentQueryKey,
  workflowEvidenceListQueryKey,
  workflowOperationQueryKey,
} from '../query-keys.js';
import {
  advanceWorkflow,
  cancelWorkflow,
  dismissWorkflow,
  fetchWorkflowCheckpointFileContent,
  fetchWorkflowEvidenceContent,
  getWorkflowCheckpoint,
  getWorkflowOperation,
  getWorkflowPayload,
  getWorkflowRun,
  getWorkflowStructure,
  listWorkflowCheckpointInventory,
  listWorkflowCheckpoints,
  listWorkflowDescriptors,
  listWorkflowEvents,
  listWorkflowEvidence,
  listWorkflowOperations,
  pauseWorkflow,
  resolveRuntimeIdentity,
  resumeWorkflow,
  retryWorkflow,
  startWorkflow,
} from '../runtime-data.js';
import { requestAttachedWorkflowRuns } from '../runtime-events.js';
import { AttachedRunsSync, attachedRunForSurface, type AttachedRuns } from './attached.js';
import { checkpointRefreshSignal } from './checkpoints.js';
import { RunSynchronizer } from './coordinator.js';
import {
  evidenceListQuery,
  evidenceQueryIdentity,
  evidenceRefreshSignal,
  type EvidenceFilters,
  type EvidenceScope,
} from './evidence.js';
import { isDiagnosticTransition, workflowLogLine, type WorkflowLogLine } from './log.js';
import { emptyRunState, selectOperations, type WorkflowRunState } from './model.js';
import { hydrateExecutionOperations, runStateAccessors } from './operations.js';
import {
  currentConnectionPhase,
  subscribeToWorkflowSignals,
  type RuntimeConnectionPhase,
} from './signals.js';
import { resolveCurrentStructure } from './structure.js';

/** Where the bar's log window starts, given where the run is now. */
export function workflowLogWindowStart(revision: number, windows = 1): number {
  return Math.max(0, revision - workflowLogWindowRevisions * windows);
}

/**
 * How many revisions of history the bar's log window opens on.
 *
 * Revisions are contiguous within a run, so a lower bound is a cheap way to ask for recent activity
 * on a route that only pages forward. Deliberately small: every item on that route is a complete
 * delta, and the bar needs a handful of lines, not a run's whole history.
 */
export const workflowLogWindowRevisions = 50;

/**
 * The runtime this session is talking to, as a cache namespace.
 *
 * Resolved once and never refetched — it is configuration, not state — and every workflow query is
 * disabled until it is known rather than being keyed on a placeholder that would later have to be
 * migrated.
 */
export function useRuntimeIdentity(): string | null {
  const { data } = useQuery({
    queryKey: runtimeIdentityQueryKey,
    queryFn: () => runRuntimeEffect(resolveRuntimeIdentity()),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
  return data ?? null;
}

/**
 * Owns the attached-run cache for the session. Mounted once, beside the runtime event subscription.
 */
export function useWorkflowRuntimeSync() {
  const queryClient = useQueryClient();
  const runtimeIdentity = useRuntimeIdentity();

  useEffect(() => {
    if (runtimeIdentity === null) return;
    const sync = new AttachedRunsSync(queryClient, runtimeIdentity);
    sync.start();
    return () => sync.stop();
  }, [queryClient, runtimeIdentity]);
}

export function useAttachedWorkflowRunsQuery() {
  const queryClient = useQueryClient();
  const runtimeIdentity = useRuntimeIdentity();
  return useQuery({
    queryKey: workflowAttachedRunsQueryKey(runtimeIdentity),
    enabled: runtimeIdentity !== null,
    // The connection's own snapshot is the read path; there is no route that lists every attached
    // run. Awaiting the snapshot lets the sync apply it (and replay anything buffered behind it)
    // before this returns, so the fetch result and the pushed cache agree instead of racing.
    queryFn: async (): Promise<AttachedRuns> => {
      await requestAttachedWorkflowRuns();
      return (
        queryClient.getQueryData<AttachedRuns>(workflowAttachedRunsQueryKey(runtimeIdentity)) ?? []
      );
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

/** The run occupying a surface, read from the same cache the palette and attention read. */
export function useAttachedWorkflowRun(
  surfaceId: number | null | undefined,
): WorkflowRunSummary | undefined {
  const { data } = useAttachedWorkflowRunsQuery();
  return useMemo(() => attachedRunForSurface(data, surfaceId), [data, surfaceId]);
}

/**
 * The synchronized projection of one run, live while a consumer is mounted.
 *
 * Starting the coordinator is what makes the expensive half of inspection demand-driven: with no
 * consumer, nothing hydrates executions, frames or operations, while the bar keeps receiving
 * summary changes through the attached-run cache.
 */
export function useWorkflowRunState(
  runId: number | null,
  options: { readonly enabled?: boolean | undefined } = {},
): WorkflowRunState | null {
  const queryClient = useQueryClient();
  const runtimeIdentity = useRuntimeIdentity();
  const enabled = (options.enabled ?? true) && runId !== null && runtimeIdentity !== null;

  useEffect(() => {
    if (!enabled || runId === null || runtimeIdentity === null) return;
    const synchronizer = new RunSynchronizer({ queryClient, runtimeIdentity, runId });
    synchronizer.start();
    return () => synchronizer.stop();
  }, [enabled, queryClient, runId, runtimeIdentity]);

  const { data } = useQuery({
    queryKey: workflowRunStateQueryKey(runtimeIdentity, runId),
    enabled,
    // The coordinator is the only writer. A `queryFn` here would be a second, unsynchronized way
    // for rows to enter the cache, which is exactly the drift one authority is meant to remove.
    queryFn: () => emptyRunState(runId ?? 0),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
  });
  return enabled ? (data ?? null) : null;
}

/**
 * Whether the shared runtime connection is up.
 *
 * The bar states this rather than implying a quiet run: an empty log on a dropped connection means
 * something different from an empty log on a live one.
 */
export function useRuntimeConnectionPhase(): RuntimeConnectionPhase {
  // Seeded from the bus's current value, not from the next transition: the bar unmounts with zen
  // mode, and a subscriber that could only learn from future signals came back saying "connecting"
  // about a socket that had been open the whole time.
  return useSyncExternalStore(subscribeToWorkflowSignals, currentConnectionPhase);
}

export interface WorkflowLogView {
  readonly runId: number | null;
  readonly lines: readonly WorkflowLogLine[];
  readonly isLoading: boolean;
  readonly error: unknown;
  readonly hasOlder: boolean;
  readonly loadEarlier: () => void;
  /** Re-reads the window after a failed read. The panel offers it; nothing retries on its own. */
  readonly retry: () => void;
}

/**
 * How many live diagnostic lines the open panel keeps.
 *
 * The window has to be bounded in both directions. Following a chatty run for long enough would
 * otherwise grow this array without limit and re-render every line each time — and the panel would
 * still be claiming to be a bounded window. Lines that roll off are not lost: they are in history,
 * and the panel says so.
 */
export const workflowLogLiveLimit = 200;

/**
 * A window of history, and how far the read that produced it is complete to.
 *
 * `coverageRevision` is local to this window and deliberately never reaches the coordinator: it
 * answers "is the window still in retention" for `hasOlder` and eviction, and nothing else. This is
 * a view of recent activity, not recovery, and treating a partially loaded window as coverage would
 * let the full coordinator skip the revisions it never read.
 */
interface WorkflowLogHistory {
  readonly lines: readonly WorkflowLogLine[];
  readonly coverageRevision: number;
}

/**
 * What an open log panel is currently reading.
 *
 * Derived during render rather than assigned by an effect, and stamped with the run it belongs to.
 * Both parts are load-bearing: the query is enabled on the very first render, so a window assigned
 * afterwards would let that first request go out unbounded — `sinceRevision=0` on a run with
 * indefinite retention means paging the entire history to draw a handful of lines. Scoping it means
 * a run swap cannot leave the new run reading the old run's window, or showing its lines.
 */
interface WorkflowLogSession {
  readonly scope: string;
  /** The run's revision when the panel opened, so the window does not slide under the reader. */
  readonly openingRevision: number;
  /** How many windows back the reader has asked for. */
  readonly depth: number;
}

function logScope(runtimeIdentity: string | null, runId: number | null): string {
  return `${runtimeIdentity ?? ''}:${runId ?? ''}`;
}

export function useWorkflowLog(
  summary: WorkflowRunSummary | null,
  options: { readonly enabled?: boolean | undefined } = {},
): WorkflowLogView {
  const queryClient = useQueryClient();
  const runtimeIdentity = useRuntimeIdentity();
  const runId = summary?.runId ?? null;
  const enabled = (options.enabled ?? true) && runId !== null && runtimeIdentity !== null;
  const scope = logScope(runtimeIdentity, runId);

  const [session, setSession] = useState<WorkflowLogSession | null>(null);
  const [live, setLive] = useState<{
    readonly scope: string;
    readonly lines: readonly WorkflowLogLine[];
    /**
     * The highest revision this buffer has dropped, or null if it has dropped nothing.
     *
     * A revision rather than a flag, because "a line rolled off" is not the same fact as "a line is
     * missing from the panel": an evicted line the history read already covers is still on screen.
     * Keeping the revision lets that be *derived* against the history's coverage instead of
     * maintained by hand, so a refetch that widens coverage settles it without anything to clear.
     */
    readonly evictedThrough: number | null;
  }>({ scope, lines: [], evictedThrough: null });

  // Adjusted during render, which is what makes the first enabled render already correct. An effect
  // here would run after the query had been created with the wrong window.
  if (enabled && session?.scope !== scope) {
    setSession({ scope, openingRevision: summary?.revision ?? 0, depth: 1 });
  } else if (!enabled && session !== null) {
    setSession(null);
  }

  const active = enabled && session?.scope === scope ? session : null;
  const windowStart = active ? workflowLogWindowStart(active.openingRevision, active.depth) : 0;
  // Live lines belong to the run that produced them. A stale batch must not be rendered for one
  // frame against its successor.
  const liveLines = live.scope === scope ? live.lines : [];
  const evictedThrough = live.scope === scope ? live.evictedThrough : null;

  /**
   * A read cannot outlive the opening that asked for it.
   *
   * Keeping the data stale is enough to stop a *completed* read being reused, but not a pending
   * one: React Query deduplicates a re-enabled observer onto the request already in flight, so a
   * panel closed and reopened mid-read would be served an answer taken before it reopened —
   * complete-looking, and missing everything recorded in between. Measured, not assumed: an
   * observer disabled and re-enabled while fetching calls its query function once; cancelling first
   * makes it two.
   */
  useEffect(() => {
    if (active === null) return;
    const key = workflowLogQueryKey(runtimeIdentity, runId, windowStart);
    return () => {
      void queryClient.cancelQueries({ queryKey: key, exact: true });
    };
  }, [active === null, queryClient, runId, runtimeIdentity, windowStart]);

  useEffect(() => {
    if (!enabled || runId === null) return;
    return subscribeToWorkflowSignals((signal) => {
      if (signal.type !== 'transition') return;
      if (signal.delta.runId !== runId || !isDiagnosticTransition(signal.delta)) return;
      const line = workflowLogLine(signal.delta);
      if (!line) return;
      setLive((current) => {
        const sameScope = current.scope === scope;
        const lines = sameScope ? current.lines : [];
        if (lines.some((existing) => existing.revision === line.revision)) return current;
        const next = [...lines, line];
        const overflow = next.length - workflowLogLiveLimit;
        if (overflow <= 0) {
          return { scope, lines: next, evictedThrough: sameScope ? current.evictedThrough : null };
        }
        const dropped = next.slice(0, overflow);
        const previous = sameScope ? current.evictedThrough : null;
        return {
          scope,
          lines: next.slice(overflow),
          evictedThrough: Math.max(previous ?? 0, ...dropped.map((entry) => entry.revision)),
        };
      });
    });
  }, [enabled, runId, scope]);

  const query = useQuery({
    queryKey: workflowLogQueryKey(runtimeIdentity, runId, windowStart),
    enabled: active !== null,
    /**
     * A point-in-time read, not an immutable one.
     *
     * It has a lower bound and no upper one — it runs to the present — so it is stale the moment it
     * lands. Claiming otherwise is what made every opening of the panel a hunt for an identity
     * unique enough to defeat the cache: first the run's revision, then a per-panel counter, each
     * outlived by the entry it was trying to distinguish. Saying what the data actually is removes
     * the question. Every new subscription re-reads; nothing has to be told apart.
     *
     * Focus refetching stays off because the live subscription already keeps an open panel current,
     * so a refetch there would be traffic with nothing to add.
     */
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async ({ signal }): Promise<WorkflowLogHistory> => {
      if (runId === null) return { lines: [], coverageRevision: 0 };
      const lines: WorkflowLogLine[] = [];
      let cursor: string | null = null;
      let coverageRevision = 0;
      do {
        const page: ListWorkflowEventsOutput = await runRuntimeEffect(
          listWorkflowEvents(runId, {
            limit: 100,
            ...(cursor === null ? { sinceRevision: windowStart } : { cursor }),
          }),
          // Abandoning a read should stop it, not merely ignore it. Without the signal the request
          // runs to completion against the runtime on behalf of a panel nobody is looking at.
          { signal },
        );
        for (const delta of page.items) {
          const line = workflowLogLine(delta);
          if (line) lines.push(line);
        }
        // How far this read is complete to. An evicted live line at or below it is still on screen,
        // because this read carries it.
        coverageRevision = page.boundary.coverageRevision;
        cursor = page.nextCursor;
      } while (cursor !== null);
      return { lines, coverageRevision };
    },
  });

  const lines = useMemo(() => {
    const byRevision = new Map<number, WorkflowLogLine>();
    for (const line of query.data?.lines ?? []) byRevision.set(line.revision, line);
    for (const line of liveLines) byRevision.set(line.revision, line);
    return [...byRevision.values()].sort((left, right) => left.revision - right.revision);
  }, [liveLines, query.data]);

  /**
   * Whether anything is genuinely missing from the panel.
   *
   * History below the window is one way; a live line evicted past what the history read covers is
   * the other. An eviction the history already carries is not a loss, so it is not announced — and
   * a re-read that widens coverage settles this on its own.
   */
  const uncoveredEviction =
    evictedThrough !== null && evictedThrough > (query.data?.coverageRevision ?? 0);

  /**
   * Widens the window, and re-reads when it cannot widen any further.
   *
   * At `windowStart === 0` a deeper session produces the same bound and therefore the same query,
   * which already holds an answer — so deepening alone left the affordance offering something it
   * could never deliver. Lines that rolled off the live cap are committed history by then, so a
   * fresh read of the same window is exactly what recovers them.
   */
  const loadEarlier = useCallback(() => {
    if (windowStart === 0) {
      void query.refetch();
      return;
    }
    setSession((current) =>
      current === null ? current : { ...current, depth: current.depth + 1 },
    );
  }, [query, windowStart]);

  return {
    runId,
    lines,
    isLoading: query.isLoading,
    error: query.error,
    // Either bound can hide activity: history below the window, or live lines that rolled off it.
    // Both are the same fact to a reader — there is more than this — so both raise it.
    hasOlder: windowStart > 0 || uncoveredEviction,
    loadEarlier,
    retry: () => {
      void query.refetch();
    },
  };
}

/**
 * The structure a run is on right now.
 *
 * The caller's expected pin keys a *mutable* lookup that is allowed to go stale; the descriptor it
 * validates is stored under the hash the response itself reported. `resolveCurrentStructure` owns
 * that separation and the refusal that goes with it.
 */
export function useWorkflowStructureQuery(
  runId: number | null,
  expectedArtifactHash: string | null,
  options: { readonly enabled?: boolean | undefined } = {},
) {
  const queryClient = useQueryClient();
  const runtimeIdentity = useRuntimeIdentity();
  return useQuery({
    queryKey: workflowCurrentStructureQueryKey(runtimeIdentity, runId, expectedArtifactHash),
    enabled: (options.enabled ?? true) && runId !== null && expectedArtifactHash !== null,
    // Mutable by nature: true only for as long as the run stays on this pin, so it is deliberately
    // not the infinitely-stale entry a graph layout is cached against.
    retry: false,
    queryFn: ({ signal }) => {
      if (runId === null || expectedArtifactHash === null) {
        throw new Error('A workflow structure read needs a run and the pin it expects.');
      }
      return resolveCurrentStructure({
        queryClient,
        runtimeIdentity,
        runId,
        expectedArtifactHash,
        fetchStructure: () => runRuntimeEffect(getWorkflowStructure(runId), { signal }),
      });
    },
  });
}

/**
 * A descriptor already validated under its own hash.
 *
 * Immutable and never invalidated, and read-only: it is populated by a validated current-structure
 * response, so there is no path by which a descriptor enters this cache under a hash it does not
 * describe.
 */
export function useWorkflowDescriptor(artifactHash: string | null) {
  const queryClient = useQueryClient();
  const runtimeIdentity = useRuntimeIdentity();
  return artifactHash === null
    ? undefined
    : queryClient.getQueryData<GetWorkflowStructureOutput>(
        workflowDescriptorQueryKey(runtimeIdentity, artifactHash),
      );
}

/** What the dock knows about one visit's operation cards while they are being read. */
export interface WorkflowOperationsView {
  /** The operations themselves, always read from the canonical projection. */
  readonly operations: readonly WorkflowOperationDto[];
  /** True once every page has been read and merged, so the list can be called complete. */
  readonly complete: boolean;
  readonly isLoading: boolean;
  readonly error: unknown;
  readonly retry: () => void;
}

/**
 * One visit's durable operations, hydrated on demand and rendered from the projection.
 *
 * The listing that hydrates a run carries no operation rows by design, so a run opened after the
 * fact has none of its history's operations in the projection. This reads every page for the one
 * selected visit and merges the keys the projection is missing; see `operations.ts` for why the
 * merge can only ever add.
 *
 * Gated on a coherent baseline: hydrating into a projection that has not settled would insert rows
 * a replacement is about to discard, and the query is keyed on that baseline's epoch so a
 * replacement re-asks rather than trusting a fill it can no longer account for.
 */
export function useWorkflowExecutionOperations(
  state: WorkflowRunState | null,
  executionId: number | null,
): WorkflowOperationsView {
  const queryClient = useQueryClient();
  const runtimeIdentity = useRuntimeIdentity();
  const runId = state?.runId ?? null;
  const hydrationEpoch = state?.hydrationEpoch ?? 0;
  const enabled =
    state !== null &&
    state.hydrated &&
    runId !== null &&
    executionId !== null &&
    runtimeIdentity !== null;

  const query = useQuery({
    queryKey: workflowExecutionOperationsQueryKey(
      runtimeIdentity,
      runId,
      executionId,
      hydrationEpoch,
    ),
    enabled,
    // A point-in-time read of an immutable-by-key set: once every page is in the projection there is
    // nothing this query can learn that a delta will not deliver first.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
    retry: false,
    queryFn: ({ signal }) => {
      if (runId === null || executionId === null) {
        throw new Error('A workflow operations read needs a run and an execution.');
      }
      return hydrateExecutionOperations({
        runId,
        executionId,
        hydrationEpoch,
        read: ({ runId: id, executionId: execution, limit, cursor }) =>
          runRuntimeEffect(
            listWorkflowOperations(id, {
              executionId: execution,
              limit,
              ...(cursor === null ? {} : { cursor }),
            }),
            { signal },
          ),
        ...runStateAccessors(queryClient, workflowRunStateQueryKey(runtimeIdentity, runId)),
        signal,
      });
    },
  });

  const operations = useMemo(
    () => (state === null || executionId === null ? [] : selectOperations(state, { executionId })),
    [executionId, state],
  );

  return {
    operations,
    // Completeness is the read's claim, not the count's: `operationSummary.count` is a fact about
    // the execution, not evidence that every card is here.
    complete: query.isSuccess,
    isLoading: enabled && query.isPending,
    error: query.error,
    retry: () => {
      void query.refetch();
    },
  };
}

/**
 * A recorded value, fetched only when someone asks to see it.
 *
 * `retry: false` and a preserved error are the point: an unreadable payload is a fact about the
 * run, and presenting it as a successful empty value would hide that a step's output is gone.
 * Refetching is the caller's explicit action.
 */
export function useWorkflowPayloadQuery(
  runId: number | null,
  payloadRef: string | null,
  options: { readonly enabled?: boolean | undefined } = {},
) {
  const runtimeIdentity = useRuntimeIdentity();
  return useQuery({
    queryKey: workflowPayloadQueryKey(runtimeIdentity, runId, payloadRef),
    enabled: (options.enabled ?? false) && runId !== null && payloadRef !== null,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
    queryFn: ({ signal }) => {
      if (runId === null || payloadRef === null) {
        throw new Error('A workflow payload read needs a run and a reference.');
      }
      return runRuntimeEffect(getWorkflowPayload(runId, payloadRef), { signal });
    },
  });
}

/**
 * Every page of one evidence listing, in one query.
 *
 * Paged completely before anything is returned, following `hydrateExecutionOperations`: a partial
 * read is not an answer, and a list that stopped at page one would understate what a run captured.
 *
 * The key carries the refresh signal rather than a clock, so this refetches exactly when a capture
 * commits. Evidence rows are immutable once written, so nothing else can change a page.
 */
export function useWorkflowEvidenceList(
  state: WorkflowRunState | null,
  /**
   * `null` when there is nothing to ask about.
   *
   * A representable state rather than a fallback scope. Substituting the run's listing for a
   * selection that has no visit would answer a question nobody asked, under a heading that says
   * "this visit and below" — and the caller has no way to tell that answer from a real one.
   */
  scope: EvidenceScope | null,
  filters: EvidenceFilters = {},
) {
  const runtimeIdentity = useRuntimeIdentity();
  const runId = state?.runId ?? null;
  const signal = scope === null ? 0 : evidenceRefreshSignal(state, scope);
  const identity = scope === null ? 'none' : evidenceQueryIdentity(scope, filters);
  const enabled = runId !== null && runtimeIdentity !== null && scope !== null;

  return useQuery({
    queryKey: workflowEvidenceListQueryKey(
      runtimeIdentity,
      runId,
      scope?.kind ?? 'none',
      identity,
      signal,
    ),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
    retry: false,
    queryFn: async ({ signal: abort }): Promise<readonly WorkflowEvidenceDto[]> => {
      if (runId === null || scope === null) {
        throw new Error('An evidence listing needs a run and a scope.');
      }
      const items: WorkflowEvidenceDto[] = [];
      let cursor: string | null = null;
      do {
        const page: ListWorkflowEvidenceOutput = await runRuntimeEffect(
          listWorkflowEvidence(runId, evidenceListQuery(scope, filters, { limit: 100, cursor })),
          { signal: abort },
        );
        items.push(...page.items);
        cursor = page.nextCursor;
        abort.throwIfAborted();
      } while (cursor !== null);
      return items;
    },
  });
}

/**
 * The bytes of one record, fetched only when someone asks to see them.
 *
 * `retry: false` and a preserved error for the same reason the payload read keeps them: content
 * that is gone or no longer matches its reference is a fact about the run, and showing an empty
 * preview instead would hide it.
 */
export function useWorkflowEvidenceContent(
  runId: number | null,
  evidenceKey: string | null,
  options: { readonly enabled?: boolean | undefined } = {},
) {
  const runtimeIdentity = useRuntimeIdentity();
  return useQuery({
    queryKey: workflowEvidenceContentQueryKey(runtimeIdentity, runId, evidenceKey),
    enabled: (options.enabled ?? false) && runId !== null && evidenceKey !== null,
    // Immutable, so it never goes stale — but immutability is a statement about freshness, not
    // about retention. Unlike a payload's bounded JSON these are arbitrary bytes: a preview
    // auto-fetches at up to 256 KB and a download pulls the whole object at any size, so keeping
    // every one for the life of the session would pin a run's worth of blobs in renderer memory.
    // Re-reading immutable bytes is cheap; holding them forever is not.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
    retry: false,
    queryFn: ({ signal }) => {
      if (runId === null || evidenceKey === null) {
        throw new Error('An evidence content read needs a run and a key.');
      }
      return runRuntimeEffect(fetchWorkflowEvidenceContent(runId, evidenceKey), { signal });
    },
  });
}

/**
 * Every checkpoint a run saved, oldest first, in one query.
 *
 * Paged to the end before anything is returned, as the evidence list is. Keyed on the run state's
 * checkpoint signal, so it refetches exactly when a visit commits a checkpoint.
 */
export function useWorkflowCheckpointList(state: WorkflowRunState | null) {
  const runtimeIdentity = useRuntimeIdentity();
  const runId = state?.runId ?? null;
  return useQuery({
    queryKey: workflowCheckpointListQueryKey(
      runtimeIdentity,
      runId,
      checkpointRefreshSignal(state),
    ),
    enabled: runId !== null && runtimeIdentity !== null,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
    retry: false,
    queryFn: async ({ signal }): Promise<readonly WorkflowCheckpointSummaryDto[]> => {
      if (runId === null) throw new Error('A checkpoint listing needs a run.');
      const items: WorkflowCheckpointSummaryDto[] = [];
      let cursor: string | null = null;
      do {
        const page: ListWorkflowCheckpointsOutput = await runRuntimeEffect(
          listWorkflowCheckpoints(runId, { limit: 100, ...(cursor === null ? {} : { cursor }) }),
          { signal },
        );
        items.push(...page.items);
        cursor = page.nextCursor;
        signal.throwIfAborted();
      } while (cursor !== null);
      return items;
    },
  });
}

/** One checkpoint's detail. Immutable once saved, so it never goes stale. */
export function useWorkflowCheckpoint(runId: number | null, checkpointId: string | null) {
  const runtimeIdentity = useRuntimeIdentity();
  return useQuery({
    queryKey: workflowCheckpointQueryKey(runtimeIdentity, runId, checkpointId),
    enabled: runId !== null && checkpointId !== null && runtimeIdentity !== null,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
    retry: false,
    queryFn: ({ signal }) => {
      if (runId === null || checkpointId === null) {
        throw new Error('A checkpoint read needs a run and a checkpoint.');
      }
      return runRuntimeEffect(getWorkflowCheckpoint(runId, checkpointId), { signal });
    },
  });
}

/**
 * A checkpoint's whole final inventory, followed to the last page.
 *
 * The runtime stores it already resolved, so this is the complete answer with no ancestor to
 * replay. A partial read is not an answer: a tree built from page one would silently omit files.
 */
export function useWorkflowCheckpointInventory(runId: number | null, checkpointId: string | null) {
  const runtimeIdentity = useRuntimeIdentity();
  return useQuery({
    queryKey: workflowCheckpointInventoryQueryKey(runtimeIdentity, runId, checkpointId),
    enabled: runId !== null && checkpointId !== null && runtimeIdentity !== null,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
    retry: false,
    queryFn: async ({ signal }): Promise<readonly WorkflowCheckpointInventoryEntry[]> => {
      if (runId === null || checkpointId === null) {
        throw new Error('A checkpoint inventory needs a run and a checkpoint.');
      }
      const entries: WorkflowCheckpointInventoryEntry[] = [];
      let cursor: string | null = null;
      do {
        const page: ListWorkflowCheckpointInventoryOutput = await runRuntimeEffect(
          listWorkflowCheckpointInventory(runId, checkpointId, {
            limit: 500,
            ...(cursor === null ? {} : { cursor }),
          }),
          { signal },
        );
        entries.push(...page.entries);
        cursor = page.nextCursor;
        signal.throwIfAborted();
      } while (cursor !== null);
      return entries;
    },
  });
}

/**
 * The bytes of one saved file, fetched only when someone asks to see them.
 *
 * Kept as an error rather than retried or emptied for the evidence content's reason: missing or
 * corrupt saved bytes are a fact about the checkpoint, shown beside its metadata.
 */
export function useWorkflowCheckpointFileContent(
  runId: number | null,
  checkpointId: string | null,
  fileId: string | null,
  options: { readonly enabled?: boolean | undefined } = {},
) {
  const runtimeIdentity = useRuntimeIdentity();
  return useQuery({
    queryKey: workflowCheckpointFileContentQueryKey(runtimeIdentity, runId, checkpointId, fileId),
    enabled:
      (options.enabled ?? false) && runId !== null && checkpointId !== null && fileId !== null,
    // Immutable, with the same bounded retention as evidence bytes.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
    retry: false,
    queryFn: ({ signal }) => {
      if (runId === null || checkpointId === null || fileId === null) {
        throw new Error('A checkpoint file read needs a run, a checkpoint and a file.');
      }
      return runRuntimeEffect(fetchWorkflowCheckpointFileContent(runId, checkpointId, fileId), {
        signal,
      });
    },
  });
}

/** One operation's provenance, followed from an evidence record's source. */
export function useWorkflowOperationQuery(
  runId: number | null,
  operationKey: string | null,
  options: { readonly enabled?: boolean | undefined } = {},
) {
  const runtimeIdentity = useRuntimeIdentity();
  return useQuery({
    queryKey: workflowOperationQueryKey(runtimeIdentity, runId, operationKey),
    enabled: (options.enabled ?? false) && runId !== null && operationKey !== null,
    // Not immutable: an operation settles, and its provenance gains a native session id and usage
    // when it does. Short rather than infinite, so a card opened mid-flight does not stay stale.
    staleTime: 5_000,
    gcTime: 5 * 60_000,
    retry: false,
    queryFn: ({ signal }) => {
      if (runId === null || operationKey === null) {
        throw new Error('An operation read needs a run and an operation key.');
      }
      return runRuntimeEffect(getWorkflowOperation(runId, operationKey), { signal });
    },
  });
}

// Controls. Each names its run explicitly and returns the runtime's own small result; none of them
// writes an outcome into the cache, because the runtime publishes what actually happened.
export function usePauseWorkflowMutation(runId: number | null) {
  return useMutation({ mutationFn: () => runControl(runId, pauseWorkflow, 'pause') });
}

export function useResumeWorkflowMutation(runId: number | null) {
  return useMutation({ mutationFn: () => runControl(runId, resumeWorkflow, 'resume') });
}

/**
 * Retry for a run this component already names — the bar's and the inspector's control.
 *
 * Binds its run when the component mounts and returns the control's own small result. The palette's
 * `useWorkflowRetryByIdMutation` is the same control bound the other way round, for a caller that
 * does not know the run until it has started one.
 */
export function useRetryWorkflowMutation(runId: number | null) {
  return useMutation({ mutationFn: () => runControl(runId, retryWorkflow, 'retry') });
}

export function useCancelWorkflowMutation(runId: number | null) {
  return useMutation({ mutationFn: () => runControl(runId, cancelWorkflow, 'cancel') });
}

export function useDismissWorkflowMutation(runId: number | null) {
  return useMutation({ mutationFn: () => runControl(runId, dismissWorkflow, 'dismiss') });
}

/**
 * Advance names the wait it answers.
 *
 * Without the wait id the runtime could only guess which question a submission belongs to, and a
 * form that was filled in against a wait the run has already left would silently answer the next
 * one.
 */
export function useAdvanceWorkflowMutation() {
  return useMutation({
    mutationFn: (input: {
      readonly runId: number;
      readonly waitId: number;
      readonly answers?: AdvanceWorkflowInput['answers'];
    }) =>
      runRuntimeEffect(
        advanceWorkflow(input.runId, {
          waitId: input.waitId,
          ...(input.answers === undefined ? {} : { answers: input.answers }),
        }),
      ),
  });
}

export function useWorkflowDescriptorsQuery(
  origin: WorkflowLaunchOrigin | null,
  options: { readonly enabled?: boolean | undefined } = {},
) {
  const runtimeIdentity = useRuntimeIdentity();
  return useQuery({
    queryKey: workflowDescriptorsQueryKey(
      runtimeIdentity,
      origin?.worktreeId ?? null,
      origin?.surfaceId ?? null,
      origin?.paneId ?? null,
      origin?.agentSessionId ?? null,
    ),
    enabled: (options.enabled ?? true) && origin !== null && runtimeIdentity !== null,
    staleTime: 30_000,
    queryFn: ({ signal }) => {
      if (origin === null) {
        throw new Error('Workflow descriptor query requires a launch origin.');
      }
      return runRuntimeEffect(listWorkflowDescriptors({ origin }), { signal });
    },
  });
}

/**
 * Start a workflow.
 *
 * The request blocks until preparing the environment has committed or failed, so it takes real time
 * and answers only one question: which run this is. What actually happened to it is a separate read,
 * deliberately — a caller that composed the two could not tell a rejected launch from a run it
 * merely failed to read back, and would report a prepared run as one that never started.
 */
export function useStartWorkflowMutation() {
  return useMutation({
    mutationFn: (input: StartWorkflowInput) => runRuntimeEffect(startWorkflow(input)),
  });
}

/**
 * Retry a run whose preparation never finished, blocking for the whole preparation as the control
 * does.
 *
 * Deliberately separate from `useRetryWorkflowMutation`, which the bar and the inspector use: that
 * one binds its run when the component mounts, and the palette does not know the run id until the
 * launch it is reporting on has returned. Named for how it binds, because the two otherwise differ
 * by word order alone.
 */
export function useWorkflowRetryByIdMutation() {
  return useMutation({ mutationFn: (runId: number) => runRuntimeEffect(retryWorkflow(runId)) });
}

/**
 * The run's own account of itself, read once, on demand.
 *
 * Not cached: this is a point-in-time answer to "what happened to the launch I just made", and the
 * run's live projection reaches every other surface through the attached-run cache and the
 * coordinator.
 */
export function useWorkflowRunSummaryMutation() {
  return useMutation({
    mutationFn: async (runId: number): Promise<WorkflowRunSummary> => {
      const output = await runRuntimeEffect(getWorkflowRun(runId));
      return output.run;
    },
  });
}

function runControl<Output>(
  runId: number | null,
  control: (runId: number) => Parameters<typeof runRuntimeEffect<Output, Error>>[0],
  name: string,
) {
  if (runId === null) throw new Error(`Workflow ${name} requires a run.`);
  return runRuntimeEffect(control(runId));
}
