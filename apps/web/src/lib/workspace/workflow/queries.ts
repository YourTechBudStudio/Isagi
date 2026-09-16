import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import type {
  AdvanceWorkflowInput,
  GetWorkflowStructureOutput,
  ListWorkflowEventsOutput,
  StartWorkflowInput,
  WorkflowLaunchOrigin,
  WorkflowRunSummary,
} from '@isagi/contracts';

import { runRuntimeEffect } from '../../runtime/run.js';
import {
  runtimeIdentityQueryKey,
  workflowAttachedRunsQueryKey,
  workflowDescriptorsQueryKey,
  workflowLogQueryKey,
  workflowPayloadQueryKey,
  workflowRunStateQueryKey,
  workflowCurrentStructureQueryKey,
  workflowDescriptorQueryKey,
} from '../query-keys.js';
import {
  advanceWorkflow,
  cancelWorkflow,
  dismissWorkflow,
  getWorkflowPayload,
  getWorkflowStructure,
  listWorkflowDescriptors,
  listWorkflowEvents,
  pauseWorkflow,
  resolveRuntimeIdentity,
  resumeWorkflow,
  retryWorkflow,
  startWorkflow,
} from '../runtime-data.js';
import { requestAttachedWorkflowRuns } from '../runtime-events.js';
import { AttachedRunsSync, attachedRunForSurface, type AttachedRuns } from './attached.js';
import { RunSynchronizer } from './coordinator.js';
import { isDiagnosticTransition, workflowLogLine, type WorkflowLogLine } from './log.js';
import { emptyRunState, type WorkflowRunState } from './model.js';
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

/** A window of history, and how far the read that produced it is complete to. */
interface WorkflowLogHistory {
  readonly lines: readonly WorkflowLogLine[];
  readonly coverageRevision: number;
}

/**
 * The bar's bounded recent-activity window.
 *
 * It reads a window of history and then follows live diagnostics. It deliberately establishes no
 * coverage: this is a view of recent activity, not recovery, and treating a partially loaded window
 * as coverage would let the full coordinator skip the revisions it never read.
 */
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

// Controls. Each names its run explicitly and returns the runtime's own small result; none of them
// writes an outcome into the cache, because the runtime publishes what actually happened.
export function usePauseWorkflowMutation(runId: number | null) {
  return useMutation({ mutationFn: () => runControl(runId, pauseWorkflow, 'pause') });
}

export function useResumeWorkflowMutation(runId: number | null) {
  return useMutation({ mutationFn: () => runControl(runId, resumeWorkflow, 'resume') });
}

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

export function useStartWorkflowMutation() {
  return useMutation({
    mutationFn: (input: StartWorkflowInput) => runRuntimeEffect(startWorkflow(input)),
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
