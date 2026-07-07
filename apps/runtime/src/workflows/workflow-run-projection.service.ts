import { Cause, Context, Effect, Layer } from 'effect';

import type {
  WorkflowBlockingWait,
  WorkflowQuestionSpecDto,
  WorkflowRunStatus,
  WorkflowRunSummary,
  WorkflowUiFeedbackDto,
} from '@isagi/contracts';

import type { DatabaseError } from '../persistence/index.js';
import {
  nextRuntimeEventEnvelope,
  RuntimeEventBus,
  type RuntimeEventBusService,
} from '../runtime-events/event-bus.js';
import { InternalRuntimeEventBus } from '../runtime-events/internal-event-bus.js';
import { WorkflowEventLedger, type WorkflowEventLedgerService } from './event-ledger.service.js';
import { WorkflowRepository, type WorkflowRepositoryService } from './repository.js';
import type { WorkflowRunErrorPayload } from './repository.js';
import type { WorkflowRunRow } from './types.js';

export interface WorkflowRunListFilters {
  readonly surfaceId?: number | undefined;
  readonly worktreeId?: number | undefined;
  readonly status?: WorkflowRunStatus | undefined;
  readonly rootOnly?: boolean | undefined;
}

export interface WorkflowRunProjectionService {
  readonly listSummaries: (
    filters?: WorkflowRunListFilters | undefined,
  ) => Effect.Effect<readonly WorkflowRunSummary[], DatabaseError>;
  readonly getSummary: (runId: number) => Effect.Effect<WorkflowRunSummary | null, DatabaseError>;
}

// The projection's per-root memory. One entry per root run id folds together every
// fact the projection caches about a run tree, so tearing a root down is a single
// `rootsById.delete(rootRunId)` — there is no set of parallel maps to keep in lockstep,
// and no cache that can outlive the run it belongs to.
interface ProjectionRootEntry {
  // Last summary JSON published on the public bus for this root; used to de-dupe an
  // identical republish. Undefined until the first publish for the root.
  lastSerialized?: string;
  // The surface this root is shown on (learned from a derived summary or a ui_feedback
  // event), so the root can be cleared when its surface is deleted. `null` = no surface.
  surfaceId?: number | null;
  // Latest ui_feedback for the run tree, cached so summary derivation can skip the ledger.
  uiFeedback?: WorkflowUiFeedbackDto;
  // The active debounce token; a later schedule bumps it so the earlier one bails.
  debounceToken?: number;
}

export const WorkflowRunProjection = Context.GenericTag<WorkflowRunProjectionService>(
  'isagi/WorkflowRunProjection',
);

export const WorkflowRunProjectionLive = Layer.scoped(
  WorkflowRunProjection,
  Effect.gen(function* () {
    const repository = yield* WorkflowRepository;
    const eventLedger = yield* WorkflowEventLedger;
    const internalBus = yield* InternalRuntimeEventBus;
    const publicBus = yield* RuntimeEventBus;
    const rootsById = new Map<number, ProjectionRootEntry>();
    let nextDebounceToken = 0;

    const service: WorkflowRunProjectionService = {
      listSummaries: (filters) =>
        listSummaries(repository, eventLedger, rootsById, filters).pipe(
          Effect.tap((summaries) =>
            Effect.sync(() => {
              if (filters) return;
              for (const summary of summaries) {
                rootEntry(rootsById, summary.runId).lastSerialized = JSON.stringify(summary);
              }
            }),
          ),
        ),
      getSummary: (runId) => summaryForRun(repository, eventLedger, rootsById, runId),
    };

    yield* service.listSummaries();

    const subscription = yield* internalBus.subscribe({
      types: [
        'workflow_run_touched',
        'workflow_run_recompute_requested',
        'surface_changed',
        'workflow_event_appended',
      ],
    });
    yield* Effect.addFinalizer(() => subscription.unsubscribe);
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const event = yield* subscription.take;
          if (event.type === 'surface_changed') {
            if (event.payload.change === 'deleted') {
              yield* clearSurface(publicBus, rootsById, event.payload.surfaceId);
            }
            return;
          }
          if (event.type === 'workflow_event_appended') {
            if (event.rootRunId !== null && event.event.type === 'ui_feedback') {
              const { type: _type, ts: _ts, runId: _runId, ...feedback } = event.event;
              const entry = rootEntry(rootsById, event.rootRunId);
              entry.uiFeedback = feedback;
              if (event.surfaceId !== null) entry.surfaceId = event.surfaceId;
              yield* scheduleRunChange({
                rootRunId: event.rootRunId,
                surfaceId: event.surfaceId,
                repository,
                eventLedger,
                publicBus,
                rootsById,
                token: ++nextDebounceToken,
              }).pipe(Effect.forkScoped);
            }
            return;
          }
          if (event.type === 'workflow_run_recompute_requested') {
            yield* scheduleRunChange({
              rootRunId: event.rootRunId,
              surfaceId: event.surfaceId,
              repository,
              eventLedger,
              publicBus,
              rootsById,
              token: ++nextDebounceToken,
            }).pipe(Effect.forkScoped);
            return;
          }
          if (event.type !== 'workflow_run_touched') return;

          yield* scheduleRunChange({
            rootRunId: event.rootRunId ?? event.runId,
            surfaceId: event.surfaceId,
            repository,
            eventLedger,
            publicBus,
            rootsById,
            token: ++nextDebounceToken,
          }).pipe(Effect.forkScoped);
        }),
      ),
    );

    return service;
  }),
);

function scheduleRunChange({
  rootRunId,
  surfaceId,
  repository,
  eventLedger,
  publicBus,
  rootsById,
  token,
}: {
  readonly rootRunId: number;
  readonly surfaceId: number | null;
  readonly repository: WorkflowRepositoryService;
  readonly eventLedger: WorkflowEventLedgerService;
  readonly publicBus: RuntimeEventBusService;
  readonly rootsById: Map<number, ProjectionRootEntry>;
  readonly token: number;
}) {
  rootEntry(rootsById, rootRunId).debounceToken = token;
  return Effect.sleep('75 millis').pipe(
    Effect.zipRight(
      Effect.gen(function* () {
        const entry = rootsById.get(rootRunId);
        if (!entry || entry.debounceToken !== token) return;
        delete entry.debounceToken;

        const summary = yield* summaryForRoot(repository, eventLedger, rootsById, rootRunId);
        if (!summary) {
          yield* publishCleared(publicBus, rootsById, rootRunId, surfaceId);
          return;
        }

        yield* publishChanged(publicBus, rootsById, summary);
      }),
    ),
    Effect.catchAllCause((cause) =>
      Effect.sync(() => {
        console.warn('[runtime] workflow run projection failed', Cause.pretty(cause));
      }),
    ),
  );
}

function listSummaries(
  repository: WorkflowRepositoryService,
  eventLedger: WorkflowEventLedgerService,
  rootsById: Map<number, ProjectionRootEntry>,
  filters?: WorkflowRunListFilters | undefined,
) {
  return Effect.gen(function* () {
    const rootOnly = filters?.rootOnly ?? true;
    const runs = yield* repository.listRuns({
      surfaceId: filters?.surfaceId,
      worktreeId: filters?.worktreeId,
      status: filters?.status,
      rootOnly,
    });
    const summaries = yield* Effect.all(
      runs.map((run) =>
        rootOnly && run.rootRunId !== null
          ? summaryForRoot(repository, eventLedger, rootsById, run.rootRunId)
          : summaryForPhysicalRun(rootsById, run),
      ),
    );
    return summaries.filter((summary): summary is WorkflowRunSummary => Boolean(summary));
  });
}

function summaryForRun(
  repository: WorkflowRepositoryService,
  eventLedger: WorkflowEventLedgerService,
  rootsById: Map<number, ProjectionRootEntry>,
  runId: number,
) {
  return Effect.gen(function* () {
    const run = yield* repository.findRun(runId);
    if (!run) return null;
    if (run.parentRunId === null && run.rootRunId !== null) {
      return yield* summaryForRoot(repository, eventLedger, rootsById, run.rootRunId);
    }
    return yield* summaryForPhysicalRun(rootsById, run);
  });
}

function summaryForRoot(
  repository: WorkflowRepositoryService,
  eventLedger: WorkflowEventLedgerService,
  rootsById: Map<number, ProjectionRootEntry>,
  rootRunId: number,
) {
  return Effect.gen(function* () {
    const runs = yield* repository.listRunTree(rootRunId);
    const uiFeedback =
      rootsById.get(rootRunId)?.uiFeedback ??
      (yield* eventLedger.latestUiFeedbackForRunTree(rootRunId).pipe(
        Effect.catchAll((error) =>
          Effect.sync(() => {
            console.warn('[runtime] workflow run ui_feedback rebuild failed', error);
            return undefined;
          }),
        ),
      ));
    if (uiFeedback) rootEntry(rootsById, rootRunId).uiFeedback = uiFeedback;
    const summary = deriveWorkflowRunSummary(runs, uiFeedback);
    if (summary?.surfaceId) rootEntry(rootsById, rootRunId).surfaceId = summary.surfaceId;
    return summary;
  });
}

function summaryForPhysicalRun(rootsById: Map<number, ProjectionRootEntry>, run: WorkflowRunRow) {
  return Effect.succeed(derivePhysicalWorkflowRunSummary(run, rootsById));
}

export function deriveWorkflowRunSummary(
  runs: readonly WorkflowRunRow[],
  uiFeedback?: WorkflowUiFeedbackDto | undefined,
): WorkflowRunSummary | null {
  const root = runs.find((run) => run.parentRunId === null) ?? runs[0] ?? null;
  if (!root || root.rootRunId === null) return null;

  const waitingUserRun = runs.find(
    (run) =>
      run.status === 'waiting' &&
      !run.paused &&
      (run.waitKind === 'user_continue' || run.waitKind === 'user_input'),
  );
  const blockingWait =
    root.status === 'done' || root.status === 'failed'
      ? null
      : waitingUserRun
        ? blockingWaitForRun(waitingUserRun)
        : blockingWaitForRun(root);

  return {
    runId: root.rootRunId,
    rootRunId: root.rootRunId,
    parentRunId: null,
    workflowKey: root.workflowKey,
    title: root.workflowTitle,
    status: root.status,
    paused: runs.some((run) => run.paused),
    waitKind: root.waitKind,
    blockingWait,
    worktreeId: root.worktreeId,
    surfaceId: root.surfaceId,
    uiFeedback,
    prompt: waitingUserRun ? promptForRun(waitingUserRun) : undefined,
    error: root.status === 'failed' ? errorMessage(root.error) : undefined,
  };
}

function derivePhysicalWorkflowRunSummary(
  run: WorkflowRunRow,
  rootsById: Map<number, ProjectionRootEntry>,
): WorkflowRunSummary {
  const rootRunId = run.rootRunId ?? run.id;
  return {
    runId: run.id,
    rootRunId,
    parentRunId: run.parentRunId,
    workflowKey: run.workflowKey,
    title: run.workflowTitle,
    status: run.status,
    paused: run.paused,
    waitKind: run.waitKind,
    blockingWait: blockingWaitForRun(run),
    worktreeId: run.worktreeId,
    surfaceId: run.surfaceId,
    uiFeedback: run.parentRunId === null ? rootsById.get(rootRunId)?.uiFeedback : undefined,
    prompt:
      run.status === 'waiting' &&
      !run.paused &&
      (run.waitKind === 'user_continue' || run.waitKind === 'user_input')
        ? promptForRun(run)
        : undefined,
    error: run.status === 'failed' ? errorMessage(run.error) : undefined,
  };
}

function blockingWaitForRun(run: WorkflowRunRow): WorkflowBlockingWait | null {
  if (run.status !== 'waiting' || run.paused || run.waitKind === null) return null;
  return { kind: run.waitKind, runId: run.id };
}

function promptForRun(run: WorkflowRunRow): WorkflowRunSummary['prompt'] {
  if (run.waitKind === 'user_continue') return { runId: run.id, questions: [] };
  const condition = parseJson(run.waitCondition);
  if (!condition || typeof condition !== 'object' || !('questions' in condition)) {
    return { runId: run.id, questions: [] };
  }
  const questions = Array.isArray(condition.questions)
    ? (condition.questions as WorkflowQuestionSpecDto[])
    : [];
  return { runId: run.id, questions };
}

function errorMessage(errorJson: string | null): string | undefined {
  const error = parseJson(errorJson) as WorkflowRunErrorPayload | undefined;
  return typeof error?.message === 'string' && error.message.length > 0 ? error.message : undefined;
}

// Tear down every root shown on a deleted surface: publish a `cleared` for the ones
// that had a live summary, and drop the rest so their cached feedback cannot linger.
// `rootsById.delete` inside `publishCleared` frees the whole entry, so this is the only
// surface-teardown path needed.
function clearSurface(
  publicBus: RuntimeEventBusService,
  rootsById: Map<number, ProjectionRootEntry>,
  surfaceId: number,
) {
  return Effect.gen(function* () {
    const roots: Array<{ readonly rootRunId: number; readonly published: boolean }> = [];
    for (const [rootRunId, entry] of rootsById) {
      if (entry.surfaceId === surfaceId) {
        roots.push({ rootRunId, published: entry.lastSerialized !== undefined });
      }
    }
    for (const { rootRunId, published } of roots) {
      if (published) {
        yield* publishCleared(publicBus, rootsById, rootRunId, surfaceId);
      } else {
        rootsById.delete(rootRunId);
      }
    }
  });
}

function rootEntry(
  rootsById: Map<number, ProjectionRootEntry>,
  rootRunId: number,
): ProjectionRootEntry {
  let entry = rootsById.get(rootRunId);
  if (!entry) {
    entry = {};
    rootsById.set(rootRunId, entry);
  }
  return entry;
}

function parseJson(value: string | null): unknown {
  if (value === null) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function publishChanged(
  publicBus: RuntimeEventBusService,
  rootsById: Map<number, ProjectionRootEntry>,
  summary: WorkflowRunSummary,
) {
  const serialized = JSON.stringify(summary);
  const entry = rootEntry(rootsById, summary.runId);
  if (entry.lastSerialized === serialized) return Effect.void;
  entry.lastSerialized = serialized;
  entry.surfaceId = summary.surfaceId;
  return publicBus.publish({
    ...nextRuntimeEventEnvelope(),
    type: 'workflow_run_changed',
    payload: summary,
  });
}

function publishCleared(
  publicBus: RuntimeEventBusService,
  rootsById: Map<number, ProjectionRootEntry>,
  rootRunId: number,
  surfaceId: number | null,
) {
  // Dropping the whole entry frees `lastSerialized`, `uiFeedback`, `surfaceId`, and any
  // debounce token in one move — the clear path can no longer leak per-root cache state.
  rootsById.delete(rootRunId);
  return publicBus.publish({
    ...nextRuntimeEventEnvelope(),
    type: 'workflow_run_cleared',
    payload: { runId: rootRunId, rootRunId, surfaceId },
  });
}
