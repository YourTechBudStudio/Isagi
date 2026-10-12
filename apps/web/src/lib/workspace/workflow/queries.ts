/**
 * Workflow reads and controls.
 *
 * Every runtime-owned workflow fact is a query atom (`lib/state/policy.ts`) kept current by the live
 * sync (`sync.ts`): pushed events are appended, and the run, execution and checkpoint list an event
 * names are re-read. Reads are never stale on a timer and never retried; a reconnect re-reads the
 * live ones. The runs attached to surfaces are a state atom the runtime-events connection writes;
 * there is no route that lists them.
 *
 * Components read the atoms with `useAtomValue` (selecting `disabledQuery` when a read is not
 * wanted), or through the two view hooks below that already return what their callers draw.
 */
import { useAtomValue } from '@effect/atom-react';
import { Duration, Effect, Option } from 'effect';
import { AsyncResult, Atom } from 'effect/reactivity';
import { useMemo } from 'react';

import type {
  AdvanceWorkflowInput,
  ListWorkflowCheckpointsOutput,
  ListWorkflowEventsOutput,
  WorkflowCheckpointSummaryDto,
  WorkflowEventDto,
  WorkflowLaunchOrigin,
  WorkflowRunSummary,
} from '@isagi/contracts';

import type { RuntimeApi } from '../../runtime/client.js';
import { keys } from '../../state/keys.js';
import { disabledQuery, query } from '../../state/policy.js';
import { useRegistry } from '../../state/registry.js';
import { queryError } from '../../state/result.js';
import { appRuntime } from '../../state/runtime.js';
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
} from '../runtime-data.js';
import { attachedRunForSurface, type AttachedRuns } from './attached.js';
import {
  mergeEvents,
  runtimeConnectionPhaseAtom,
  workflowLive,
  type RuntimeConnectionPhase,
} from './live.js';
import { workflowLogLines, type WorkflowLogLine } from './log.js';
import { buildRunView, type WorkflowRunView } from './run-view.js';

/** The route's own maximum. The event log and the checkpoint list are read forward in pages. */
const pageSize = 500;

/**
 * Workflow reads: never stale on a timer (the socket keeps them current), kept five minutes after
 * the last reader, and not retried — a failed read is shown, with a retry the person chooses.
 */
const workflowReadPolicy = { staleTime: Duration.infinity, retry: false } as const;

// --- Session facts ------------------------------------------------------------------------------

/**
 * The runtime this session is talking to. Configuration, not state: resolved once and kept for the
 * session. Used only to scope the bar's action feedback; workflow reads are not keyed on it.
 */
export const runtimeIdentityAtom = query(() => resolveRuntimeIdentity(), {
  keys: [],
  staleTime: Duration.infinity,
  idleTTL: Duration.infinity,
});

export function useRuntimeIdentity(): string | null {
  return Option.getOrNull(AsyncResult.value(useAtomValue(runtimeIdentityAtom)));
}

/**
 * The runs occupying surfaces, as the workflow bar, the palette and attention read them. Written
 * only by the live sync: the connection's snapshot replaces it and each changed summary is upserted
 * (`attached.ts`). `undefined` until the first snapshot arrives.
 */
export const attachedRunsAtom = Atom.make<AttachedRuns | undefined>(undefined).pipe(Atom.keepAlive);

export function useAttachedWorkflowRuns(): AttachedRuns | undefined {
  return useAtomValue(attachedRunsAtom);
}

/** The run occupying a surface, read from the same atom the palette and attention read. */
export function useAttachedWorkflowRun(
  surfaceId: number | null | undefined,
): WorkflowRunSummary | undefined {
  const runs = useAtomValue(attachedRunsAtom);
  return useMemo(() => attachedRunForSurface(runs, surfaceId), [runs, surfaceId]);
}

/**
 * Whether the shared runtime connection is up.
 *
 * The bar states this rather than implying a quiet run: an empty log on a dropped connection means
 * something different from an empty log on a live one.
 */
export function useRuntimeConnectionPhase(): RuntimeConnectionPhase {
  return useAtomValue(runtimeConnectionPhaseAtom);
}

// --- Live reads (re-read on reconnect and when an event names them) ------------------------------

/** One run's detail: its summary, inputs and execution tree. */
export const workflowRunAtom = Atom.family((runId: number) =>
  query(() => getWorkflowRun(runId), {
    keys: [keys.workflowRun(runId), keys.workflowLive],
    ...workflowReadPolicy,
  }),
);

/**
 * A run's whole event log, read forward from the beginning in pages.
 *
 * Whatever was already held, and whatever was pushed while the read was in flight, is merged in by
 * id rather than overwritten: a reconnect re-reads from the beginning because event ids are global
 * across runs, so a gap in one run's list cannot be detected.
 */
export const workflowEventsAtom = Atom.family((runId: number) =>
  query(
    (get) =>
      Effect.gen(function* () {
        const fetched: WorkflowEventDto[] = [];
        let cursor: number | null = null;
        for (;;) {
          const page: ListWorkflowEventsOutput = yield* listWorkflowEvents(runId, {
            limit: pageSize,
            ...(cursor === null ? {} : { cursor }),
          });
          fetched.push(...page.items);
          if (page.nextCursor === null) break;
          cursor = page.nextCursor;
        }
        const live = yield* workflowLive;
        const cached = Option.getOrElse(
          Option.flatMap(
            get.self<AsyncResult.AsyncResult<readonly WorkflowEventDto[], Error>>(),
            AsyncResult.value,
          ),
          (): readonly WorkflowEventDto[] => [],
        );
        return mergeEvents(mergeEvents(cached, fetched), live.takeHeld(runId));
      }),
    { keys: [keys.workflowEvents(runId), keys.workflowLive], ...workflowReadPolicy },
  ),
);

/** One execution in full, with its operations. */
export const workflowExecutionAtom = Atom.family((executionId: number) =>
  query(() => Effect.map(getWorkflowExecution(executionId), (output) => output.execution), {
    keys: [keys.workflowExecution(executionId), keys.workflowLive],
    ...workflowReadPolicy,
  }),
);

/** Every checkpoint a run saved, oldest first. Re-read when a `checkpoint_captured` event arrives. */
export const workflowCheckpointListAtom = Atom.family((runId: number) =>
  query(
    () =>
      Effect.gen(function* () {
        const items: WorkflowCheckpointSummaryDto[] = [];
        let cursor: number | null = null;
        for (;;) {
          const page: ListWorkflowCheckpointsOutput = yield* listWorkflowCheckpoints(runId, {
            limit: pageSize,
            ...(cursor === null ? {} : { cursor }),
          });
          items.push(...page.items);
          if (page.nextCursor === null) break;
          cursor = page.nextCursor;
        }
        return items as readonly WorkflowCheckpointSummaryDto[];
      }),
    { keys: [keys.workflowCheckpoints(runId), keys.workflowLive], ...workflowReadPolicy },
  ),
);

// --- Immutable reads ----------------------------------------------------------------------------

/** The structure of one build the run has used. Immutable under its hash. */
export const workflowStructureAtom = Atom.family(
  ([runId, artifactHash]: readonly [runId: number, artifactHash: string]) =>
    query(() => getWorkflowStructure(runId, artifactHash), { keys: [], ...workflowReadPolicy }),
);

/** One checkpoint with every file it saved. Immutable once saved. */
export const workflowCheckpointAtom = Atom.family((checkpointId: number) =>
  query(() => Effect.map(getWorkflowCheckpoint(checkpointId), (output) => output.checkpoint), {
    keys: [],
    ...workflowReadPolicy,
  }),
);

/**
 * The bytes of one saved file, read only when someone asks to see them (select `disabledQuery`
 * otherwise).
 *
 * Kept as an error rather than retried or emptied: missing saved bytes are a fact about the
 * checkpoint, shown beside its metadata. Immutable, with bounded retention because these are
 * arbitrary bytes.
 */
export const workflowCheckpointFileAtom = Atom.family(
  ([checkpointId, path]: readonly [checkpointId: number, path: string]) =>
    query(() => fetchWorkflowCheckpointFile(checkpointId, path), {
      keys: [],
      ...workflowReadPolicy,
    }),
);

/**
 * The workflows that can be launched from an origin. A launch origin is a flat tuple so the family
 * can key on it; an optional id the origin left out stays `undefined`, so the request carries the
 * origin exactly as it was built. Default retry, 30 s stale.
 */
type DescriptorsOrigin = readonly [
  worktreeId: number,
  surfaceId: number | null,
  paneId: number | null | undefined,
  agentSessionId: number | null | undefined,
];

export const workflowDescriptorsAtom = Atom.family(
  ([worktreeId, surfaceId, paneId, agentSessionId]: DescriptorsOrigin) =>
    query(
      () =>
        listWorkflowDescriptors({
          origin: {
            worktreeId,
            surfaceId,
            ...(paneId === undefined ? {} : { paneId }),
            ...(agentSessionId === undefined ? {} : { agentSessionId }),
          },
        }),
      { keys: [], staleTime: Duration.seconds(30) },
    ),
);

/** The descriptors read for one launch origin. */
export const workflowDescriptorsFor = (origin: WorkflowLaunchOrigin) =>
  workflowDescriptorsAtom([
    origin.worktreeId,
    origin.surfaceId,
    origin.paneId,
    origin.agentSessionId,
  ]);

// --- Views ----------------------------------------------------------------------------------------

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
 * Both are ordinary queries: the live sync appends pushed events and re-reads the run detail when
 * an event names it, so this hook does no bookkeeping of its own. Their failures are reported
 * separately, because a run whose events could not be read is a partial record, not an empty one.
 */
export function useWorkflowRunView(
  runId: number | null,
  options: { readonly enabled?: boolean | undefined } = {},
): WorkflowRunViewState {
  const registry = useRegistry();
  const enabled = (options.enabled ?? true) && runId !== null;
  const detailAtom = enabled ? workflowRunAtom(runId) : disabledQuery;
  const eventsAtom = enabled ? workflowEventsAtom(runId) : disabledQuery;
  const detail = useAtomValue(detailAtom);
  const events = useAtomValue(eventsAtom);
  const detailData = Option.getOrUndefined(AsyncResult.value(detail));
  const eventsData = Option.getOrUndefined(AsyncResult.value(events));

  const view = useMemo(
    () => (detailData === undefined ? null : buildRunView(detailData, eventsData)),
    [detailData, eventsData],
  );

  return {
    view: enabled ? view : null,
    isLoading: enabled && (detail._tag === 'Initial' || events._tag === 'Initial'),
    runError: enabled ? queryError(detail) : null,
    eventsError: enabled ? queryError(events) : null,
    retry: () => {
      if (detail._tag === 'Failure') registry.refresh(detailAtom);
      if (events._tag === 'Failure') registry.refresh(eventsAtom);
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
  const registry = useRegistry();
  const runId = summary?.runId ?? null;
  const eventsAtom =
    (options.enabled ?? true) && runId !== null ? workflowEventsAtom(runId) : disabledQuery;
  const events = useAtomValue(eventsAtom);
  const eventsData = Option.getOrUndefined(AsyncResult.value(events));
  const lines = useMemo(() => workflowLogLines(eventsData ?? []), [eventsData]);
  return {
    runId,
    lines,
    isLoading: events._tag === 'Initial' && events.waiting,
    error: queryError(events),
    retry: () => registry.refresh(eventsAtom),
  };
}

// --- Controls -----------------------------------------------------------------------------------

/**
 * The bar's six controls for one run, as fn atoms owned by the component that builds them
 * (`useMemo` on `runId`): each reports its own pending/error state, and a new run gets fresh state.
 *
 * Each names its run explicitly and returns the runtime's own small result; none writes an outcome
 * into a read, because the runtime pushes what actually happened. Writes are uninterruptible: an
 * unmount or a second click must not abort a control that has reached the runtime.
 *
 * Advance names the waiting execution it answers, so a form filled in against a wait the run has
 * already left cannot silently answer the next one.
 */
export const workflowControlAtoms = (runId: number | null) => {
  const control = <A>(name: string, call: (runId: number) => Effect.Effect<A, Error, RuntimeApi>) =>
    appRuntime.fn(() =>
      runId === null
        ? Effect.die(new Error(`Workflow ${name} requires a run.`))
        : Effect.uninterruptible(call(runId)),
    );
  return {
    pause: control('pause', pauseWorkflow),
    resume: control('resume', resumeWorkflow),
    retry: control('retry', retryWorkflow),
    cancel: control('cancel', cancelWorkflow),
    dismiss: control('dismiss', dismissWorkflow),
    advance: appRuntime.fn(
      (input: {
        readonly executionId: number;
        readonly answers?: AdvanceWorkflowInput['answers'] | undefined;
      }) =>
        runId === null
          ? Effect.die(new Error('Workflow advance requires a run.'))
          : Effect.uninterruptible(
              advanceWorkflow(runId, {
                executionId: input.executionId,
                ...(input.answers === undefined ? {} : { answers: input.answers }),
              }),
            ),
    ),
  };
};

export type WorkflowControlAtoms = ReturnType<typeof workflowControlAtoms>;
