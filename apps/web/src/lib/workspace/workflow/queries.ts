import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useSyncExternalStore } from 'react';

import type {
  AdvanceWorkflowInput,
  ListWorkflowCheckpointsOutput,
  StartWorkflowInput,
  WorkflowCheckpointSummaryDto,
  WorkflowLaunchOrigin,
  WorkflowRunSummary,
} from '@isagi/contracts';

import { runRuntimeEffect } from '../../runtime/run.js';
import {
  runtimeIdentityQueryKey,
  workflowAttachedRunsQueryKey,
  workflowCheckpointFileQueryKey,
  workflowCheckpointListQueryKey,
  workflowCheckpointQueryKey,
  workflowDescriptorsQueryKey,
  workflowEventsQueryKey,
  workflowExecutionQueryKey,
  workflowRunQueryKey,
  workflowStructureQueryKey,
} from '../query-keys.js';
import {
  advanceWorkflow,
  cancelWorkflow,
  dismissWorkflow,
  fetchWorkflowCheckpointFile,
  getWorkflowCheckpoint,
  getWorkflowExecution,
  getWorkflowRun,
  getWorkflowStructure,
  listWorkflowCheckpoints,
  listWorkflowDescriptors,
  listWorkflowEvents,
  pauseWorkflow,
  resolveRuntimeIdentity,
  resumeWorkflow,
  retryWorkflow,
  startWorkflow,
} from '../runtime-data.js';
import { requestAttachedWorkflowRuns } from '../runtime-events.js';
import { attachedRunForSurface, type AttachedRuns } from './attached.js';
import { WorkflowLiveSync, loadWorkflowEvents } from './live.js';
import { workflowLogLines, type WorkflowLogLine } from './log.js';
import { buildRunView, type WorkflowRunView } from './run-view.js';
import {
  currentConnectionPhase,
  subscribeToWorkflowSignals,
  type RuntimeConnectionPhase,
} from './signals.js';

/** The route's own maximum. The event log is read forward in pages this size. */
const eventPageSize = 500;

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

/** Keeps every workflow cache live. Mounted once, beside the runtime event subscription. */
export function useWorkflowRuntimeSync() {
  const queryClient = useQueryClient();
  const runtimeIdentity = useRuntimeIdentity();

  useEffect(() => {
    if (runtimeIdentity === null) return;
    const sync = new WorkflowLiveSync({ queryClient, runtimeIdentity });
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
    // run. The live sync writes the snapshot into this cache when it arrives.
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
 * Whether the shared runtime connection is up.
 *
 * The bar states this rather than implying a quiet run: an empty log on a dropped connection means
 * something different from an empty log on a live one.
 */
export function useRuntimeConnectionPhase(): RuntimeConnectionPhase {
  return useSyncExternalStore(subscribeToWorkflowSignals, currentConnectionPhase);
}

function useWorkflowEventsQuery(runId: number | null, enabled: boolean) {
  const queryClient = useQueryClient();
  const runtimeIdentity = useRuntimeIdentity();
  return useQuery({
    queryKey: workflowEventsQueryKey(runtimeIdentity, runId),
    enabled: enabled && runId !== null && runtimeIdentity !== null,
    // Kept current by the socket; refetched only when the live sync asks.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
    retry: false,
    queryFn: ({ signal }) => {
      if (runId === null) throw new Error('A workflow event read needs a run.');
      return loadWorkflowEvents({
        queryClient,
        runtimeIdentity,
        runId,
        signal,
        list: (cursor) =>
          runRuntimeEffect(
            listWorkflowEvents(runId, {
              limit: eventPageSize,
              ...(cursor === null ? {} : { cursor }),
            }),
            { signal },
          ),
      });
    },
  });
}

export interface WorkflowRunViewState {
  /** Null until the run detail has been read. */
  readonly view: WorkflowRunView | null;
  readonly isLoading: boolean;
  /**
   * The last run-detail read failed. With no `view` nothing can be shown; with one, what is shown
   * may be out of date.
   */
  readonly runError: unknown;
  /** The event log could not be read, so pauses, reloads, wait timing and run events are missing. */
  readonly eventsError: unknown;
  readonly retry: () => void;
}

/**
 * One run's tree and event log, live while mounted.
 *
 * Both are ordinary queries: the live sync appends pushed events and refetches the run detail when
 * an event names it, so this hook does no bookkeeping of its own. Their failures are reported
 * separately, because a run whose events could not be read is a partial record, not an empty one.
 */
export function useWorkflowRunView(
  runId: number | null,
  options: { readonly enabled?: boolean | undefined } = {},
): WorkflowRunViewState {
  const runtimeIdentity = useRuntimeIdentity();
  const enabled = (options.enabled ?? true) && runId !== null && runtimeIdentity !== null;
  const detail = useQuery({
    queryKey: workflowRunQueryKey(runtimeIdentity, runId),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
    retry: false,
    queryFn: ({ signal }) => {
      if (runId === null) throw new Error('A workflow run read needs a run.');
      return runRuntimeEffect(getWorkflowRun(runId), { signal });
    },
  });
  const events = useWorkflowEventsQuery(runId, enabled);

  const view = useMemo(
    () => (detail.data === undefined ? null : buildRunView(detail.data, events.data)),
    [detail.data, events.data],
  );

  return {
    view: enabled ? view : null,
    isLoading: enabled && (detail.isPending || events.isPending),
    runError: enabled ? detail.error : null,
    eventsError: enabled ? events.error : null,
    retry: () => {
      if (detail.error) void detail.refetch();
      if (events.error) void events.refetch();
    },
  };
}

export interface WorkflowLogView {
  readonly runId: number | null;
  readonly lines: readonly WorkflowLogLine[];
  readonly isLoading: boolean;
  readonly error: unknown;
  /** Re-reads after a failed read. The panel offers it; nothing retries on its own. */
  readonly retry: () => void;
}

/** The bar's log: the run's `log` and `ui_feedback` events, read from the same event list. */
export function useWorkflowLog(
  summary: WorkflowRunSummary | null,
  options: { readonly enabled?: boolean | undefined } = {},
): WorkflowLogView {
  const runId = summary?.runId ?? null;
  const events = useWorkflowEventsQuery(runId, options.enabled ?? true);
  const lines = useMemo(() => workflowLogLines(events.data ?? []), [events.data]);
  return {
    runId,
    lines,
    isLoading: events.isLoading,
    error: events.error,
    retry: () => {
      void events.refetch();
    },
  };
}

/** The structure of one build the run has used. Immutable under its hash. */
export function useWorkflowStructureQuery(runId: number | null, artifactHash: string | null) {
  const runtimeIdentity = useRuntimeIdentity();
  return useQuery({
    queryKey: workflowStructureQueryKey(runtimeIdentity, runId, artifactHash),
    enabled: runId !== null && artifactHash !== null && runtimeIdentity !== null,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    queryFn: ({ signal }) => {
      if (runId === null || artifactHash === null) {
        throw new Error('A workflow structure read needs a run and a build.');
      }
      return runRuntimeEffect(getWorkflowStructure(runId, artifactHash), { signal });
    },
  });
}

/** One execution in full, with its operations. Refetched by the live sync when an event names it. */
export function useWorkflowExecutionQuery(executionId: number | null) {
  const runtimeIdentity = useRuntimeIdentity();
  return useQuery({
    queryKey: workflowExecutionQueryKey(runtimeIdentity, executionId),
    enabled: executionId !== null && runtimeIdentity !== null,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
    retry: false,
    queryFn: async ({ signal }) => {
      if (executionId === null) throw new Error('A workflow execution read needs an execution.');
      const output = await runRuntimeEffect(getWorkflowExecution(executionId), { signal });
      return output.execution;
    },
  });
}

/** Every checkpoint a run saved, oldest first. Refetched when a `checkpoint_captured` event arrives. */
export function useWorkflowCheckpointList(runId: number | null) {
  const runtimeIdentity = useRuntimeIdentity();
  return useQuery({
    queryKey: workflowCheckpointListQueryKey(runtimeIdentity, runId),
    enabled: runId !== null && runtimeIdentity !== null,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
    retry: false,
    queryFn: async ({ signal }): Promise<readonly WorkflowCheckpointSummaryDto[]> => {
      if (runId === null) throw new Error('A checkpoint listing needs a run.');
      const items: WorkflowCheckpointSummaryDto[] = [];
      let cursor: number | null = null;
      for (;;) {
        const page: ListWorkflowCheckpointsOutput = await runRuntimeEffect(
          listWorkflowCheckpoints(runId, {
            limit: eventPageSize,
            ...(cursor === null ? {} : { cursor }),
          }),
          { signal },
        );
        items.push(...page.items);
        signal.throwIfAborted();
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      return items;
    },
  });
}

/** One checkpoint with every file it saved. Immutable once saved, so it never goes stale. */
export function useWorkflowCheckpoint(checkpointId: number | null) {
  const runtimeIdentity = useRuntimeIdentity();
  return useQuery({
    queryKey: workflowCheckpointQueryKey(runtimeIdentity, checkpointId),
    enabled: checkpointId !== null && runtimeIdentity !== null,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
    retry: false,
    queryFn: async ({ signal }) => {
      if (checkpointId === null) throw new Error('A checkpoint read needs a checkpoint.');
      const output = await runRuntimeEffect(getWorkflowCheckpoint(checkpointId), { signal });
      return output.checkpoint;
    },
  });
}

/**
 * The bytes of one saved file, fetched only when someone asks to see them.
 *
 * Kept as an error rather than retried or emptied: missing saved bytes are a fact about the
 * checkpoint, shown beside its metadata. Immutable, with bounded retention because these are
 * arbitrary bytes.
 */
export function useWorkflowCheckpointFileContent(
  checkpointId: number | null,
  path: string | null,
  options: { readonly enabled?: boolean | undefined } = {},
) {
  const runtimeIdentity = useRuntimeIdentity();
  return useQuery({
    queryKey: workflowCheckpointFileQueryKey(runtimeIdentity, checkpointId, path),
    enabled: (options.enabled ?? false) && checkpointId !== null && path !== null,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
    retry: false,
    queryFn: ({ signal }) => {
      if (checkpointId === null || path === null) {
        throw new Error('A checkpoint file read needs a checkpoint and a path.');
      }
      return runRuntimeEffect(fetchWorkflowCheckpointFile(checkpointId, path), { signal });
    },
  });
}

// Controls. Each names its run explicitly and returns the runtime's own small result; none of them
// writes an outcome into the cache, because the runtime pushes what actually happened.
export function usePauseWorkflowMutation(runId: number | null) {
  return useMutation({ mutationFn: () => runControl(runId, pauseWorkflow, 'pause') });
}

export function useResumeWorkflowMutation(runId: number | null) {
  return useMutation({ mutationFn: () => runControl(runId, resumeWorkflow, 'resume') });
}

/**
 * Retry for a run this component already names — the bar's control.
 *
 * The palette's `useWorkflowRetryByIdMutation` is the same control bound the other way round, for a
 * caller that does not know the run until it has started one.
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
 * Advance names the waiting execution it answers, so a form filled in against a wait the run has
 * already left cannot silently answer the next one.
 */
export function useAdvanceWorkflowMutation() {
  return useMutation({
    mutationFn: (input: {
      readonly runId: number;
      readonly executionId: number;
      readonly answers?: AdvanceWorkflowInput['answers'];
    }) =>
      runRuntimeEffect(
        advanceWorkflow(input.runId, {
          executionId: input.executionId,
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
 * merely failed to read back.
 */
export function useStartWorkflowMutation() {
  return useMutation({
    mutationFn: (input: StartWorkflowInput) => runRuntimeEffect(startWorkflow(input)),
  });
}

/**
 * Retry a run the caller only knows by id — the palette's, after a launch whose preparation failed.
 *
 * Separate from `useRetryWorkflowMutation`, which binds its run when the component mounts.
 */
export function useWorkflowRetryByIdMutation() {
  return useMutation({ mutationFn: (runId: number) => runRuntimeEffect(retryWorkflow(runId)) });
}

/**
 * The run's own account of itself, read once, on demand: "what happened to the launch I just made".
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
