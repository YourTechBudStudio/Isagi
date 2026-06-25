import { Cause, Context, Effect, Layer } from 'effect';

import type {
  WorkflowQuestionSpecDto,
  WorkflowSurfaceStatus,
  WorkflowSurfaceSummary,
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

export interface WorkflowSurfaceProjectionService {
  readonly listSummaries: Effect.Effect<readonly WorkflowSurfaceSummary[], DatabaseError>;
}

export const WorkflowSurfaceProjection = Context.GenericTag<WorkflowSurfaceProjectionService>(
  'isagi/WorkflowSurfaceProjection',
);

export const WorkflowSurfaceProjectionLive = Layer.scoped(
  WorkflowSurfaceProjection,
  Effect.gen(function* () {
    const repository = yield* WorkflowRepository;
    const eventLedger = yield* WorkflowEventLedger;
    const internalBus = yield* InternalRuntimeEventBus;
    const publicBus = yield* RuntimeEventBus;
    const lastBySurfaceId = new Map<number, string>();
    const uiFeedbackByRootRunId = new Map<number, WorkflowUiFeedbackDto>();
    const uiFeedbackSurfaceByRootRunId = new Map<number, number>();
    const debounceTokensByKey = new Map<string, number>();
    let nextDebounceToken = 0;

    const service: WorkflowSurfaceProjectionService = {
      listSummaries: listActiveSummaries(
        repository,
        eventLedger,
        uiFeedbackByRootRunId,
        uiFeedbackSurfaceByRootRunId,
      ).pipe(
        Effect.tap((summaries) =>
          Effect.sync(() => {
            lastBySurfaceId.clear();
            for (const summary of summaries) {
              lastBySurfaceId.set(summary.surfaceId, JSON.stringify(summary));
            }
          }),
        ),
      ),
    };

    const subscription = yield* internalBus.subscribe({
      types: [
        'workflow_run_changed',
        'workflow_surface_recompute_requested',
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
              yield* publishCleared(publicBus, lastBySurfaceId, event.payload.surfaceId);
              clearUiFeedbackForSurface(
                uiFeedbackByRootRunId,
                uiFeedbackSurfaceByRootRunId,
                event.payload.surfaceId,
              );
            }
            return;
          }
          if (event.type === 'workflow_event_appended') {
            if (event.rootRunId !== null && event.event.type === 'ui_feedback') {
              const { type: _type, ts: _ts, runId: _runId, ...feedback } = event.event;
              uiFeedbackByRootRunId.set(event.rootRunId, feedback);
              if (event.surfaceId !== null) {
                uiFeedbackSurfaceByRootRunId.set(event.rootRunId, event.surfaceId);
              }
            }
            return;
          }
          if (event.type === 'workflow_surface_recompute_requested') {
            yield* scheduleRunChange({
              event: {
                runId: event.rootRunId,
                rootRunId: event.rootRunId,
                surfaceId: event.surfaceId,
              },
              repository,
              eventLedger,
              publicBus,
              lastBySurfaceId,
              uiFeedbackByRootRunId,
              uiFeedbackSurfaceByRootRunId,
              debounceTokensByKey,
              token: ++nextDebounceToken,
            }).pipe(Effect.forkScoped);
            return;
          }
          if (event.type !== 'workflow_run_changed') {
            return;
          }

          yield* scheduleRunChange({
            event,
            repository,
            eventLedger,
            publicBus,
            lastBySurfaceId,
            uiFeedbackByRootRunId,
            uiFeedbackSurfaceByRootRunId,
            debounceTokensByKey,
            token: ++nextDebounceToken,
          }).pipe(Effect.forkScoped);
        }),
      ),
    );

    return service;
  }),
);

function scheduleRunChange({
  event,
  repository,
  eventLedger,
  publicBus,
  lastBySurfaceId,
  uiFeedbackByRootRunId,
  uiFeedbackSurfaceByRootRunId,
  debounceTokensByKey,
  token,
}: {
  readonly event: {
    readonly runId: number;
    readonly rootRunId: number | null;
    readonly surfaceId: number | null;
  };
  readonly repository: WorkflowRepositoryService;
  readonly eventLedger: WorkflowEventLedgerService;
  readonly publicBus: RuntimeEventBusService;
  readonly lastBySurfaceId: Map<number, string>;
  readonly uiFeedbackByRootRunId: Map<number, WorkflowUiFeedbackDto>;
  readonly uiFeedbackSurfaceByRootRunId: Map<number, number>;
  readonly debounceTokensByKey: Map<string, number>;
  readonly token: number;
}) {
  const key =
    event.rootRunId !== null
      ? `root:${event.rootRunId}`
      : event.surfaceId !== null
        ? `surface:${event.surfaceId}`
        : `run:${event.runId}`;
  debounceTokensByKey.set(key, token);
  return Effect.sleep('75 millis').pipe(
    Effect.zipRight(
      Effect.gen(function* () {
        if (debounceTokensByKey.get(key) !== token) return;
        debounceTokensByKey.delete(key);

        if (event.rootRunId === null) {
          if (event.surfaceId !== null) {
            yield* publishCleared(publicBus, lastBySurfaceId, event.surfaceId);
          }
          return;
        }

        const summary = yield* summaryForRoot(
          repository,
          eventLedger,
          uiFeedbackByRootRunId,
          uiFeedbackSurfaceByRootRunId,
          event.rootRunId,
        );
        if (!summary) {
          if (event.surfaceId !== null) {
            yield* publishCleared(publicBus, lastBySurfaceId, event.surfaceId);
          }
          return;
        }

        yield* publishChanged(publicBus, lastBySurfaceId, summary);
      }),
    ),
    Effect.catchAllCause((cause) =>
      Effect.sync(() => {
        console.warn('[runtime] workflow surface projection failed', Cause.pretty(cause));
      }),
    ),
  );
}

function listActiveSummaries(
  repository: WorkflowRepositoryService,
  eventLedger: WorkflowEventLedgerService,
  uiFeedbackByRootRunId: Map<number, WorkflowUiFeedbackDto>,
  uiFeedbackSurfaceByRootRunId: Map<number, number>,
) {
  return Effect.gen(function* () {
    const roots = yield* repository.listSurfaceRootRuns;
    const summaries = yield* Effect.all(
      roots.flatMap((root) =>
        root.rootRunId === null
          ? []
          : [
              summaryForRoot(
                repository,
                eventLedger,
                uiFeedbackByRootRunId,
                uiFeedbackSurfaceByRootRunId,
                root.rootRunId,
              ),
            ],
      ),
    );
    return summaries.filter((summary): summary is WorkflowSurfaceSummary => Boolean(summary));
  });
}

function summaryForRoot(
  repository: WorkflowRepositoryService,
  eventLedger: WorkflowEventLedgerService,
  uiFeedbackByRootRunId: Map<number, WorkflowUiFeedbackDto>,
  uiFeedbackSurfaceByRootRunId: Map<number, number>,
  rootRunId: number,
) {
  return Effect.gen(function* () {
    const runs = yield* repository.listRunTree(rootRunId);
    const uiFeedback =
      uiFeedbackByRootRunId.get(rootRunId) ??
      (yield* eventLedger.latestUiFeedbackForRunTree(rootRunId).pipe(
        Effect.catchAll((error) =>
          Effect.sync(() => {
            console.warn('[runtime] workflow surface ui_feedback rebuild failed', error);
            return undefined;
          }),
        ),
      ));
    if (uiFeedback) uiFeedbackByRootRunId.set(rootRunId, uiFeedback);
    const summary = deriveWorkflowSurfaceSummary(runs, uiFeedback);
    if (summary) uiFeedbackSurfaceByRootRunId.set(rootRunId, summary.surfaceId);
    return summary;
  });
}

export function deriveWorkflowSurfaceSummary(
  runs: readonly WorkflowRunRow[],
  uiFeedback?: WorkflowUiFeedbackDto | undefined,
): WorkflowSurfaceSummary | null {
  const root = runs.find((run) => run.parentRunId === null) ?? runs[0] ?? null;
  if (!root || root.rootRunId === null || root.surfaceId === null) return null;

  // A paused run still carries its `waiting` status + user wait_kind; `paused`
  // must win so the bar offers Resume (not an inert Pause + dead prompt) and the
  // rail doesn't falsely signal "needs you". Resume re-arms the wait, so the
  // surface returns to `waiting_user` with its prompt intact.
  const waitingUserRun = runs.find(
    (run) =>
      run.status === 'waiting' &&
      !run.paused &&
      (run.waitKind === 'user_continue' || run.waitKind === 'user_input'),
  );
  const status: WorkflowSurfaceStatus = waitingUserRun
    ? 'waiting_user'
    : runs.some((run) => run.paused)
      ? 'paused'
      : root.status === 'failed'
        ? 'failed'
        : root.status === 'done'
          ? 'done'
          : 'driving';

  return {
    surfaceId: root.surfaceId,
    rootRunId: root.rootRunId,
    status,
    title: root.workflowTitle,
    uiFeedback,
    prompt: waitingUserRun ? promptForRun(waitingUserRun) : undefined,
    error: root.status === 'failed' ? errorMessage(root.error) : undefined,
  };
}

function promptForRun(run: WorkflowRunRow): WorkflowSurfaceSummary['prompt'] {
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

function clearUiFeedbackForSurface(
  uiFeedbackByRootRunId: Map<number, WorkflowUiFeedbackDto>,
  uiFeedbackSurfaceByRootRunId: Map<number, number>,
  surfaceId: number,
) {
  for (const [rootRunId, rootSurfaceId] of uiFeedbackSurfaceByRootRunId) {
    if (rootSurfaceId !== surfaceId) continue;
    uiFeedbackSurfaceByRootRunId.delete(rootRunId);
    uiFeedbackByRootRunId.delete(rootRunId);
  }
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
  lastBySurfaceId: Map<number, string>,
  summary: WorkflowSurfaceSummary,
) {
  const serialized = JSON.stringify(summary);
  if (lastBySurfaceId.get(summary.surfaceId) === serialized) return Effect.void;
  lastBySurfaceId.set(summary.surfaceId, serialized);
  return publicBus.publish({
    ...nextRuntimeEventEnvelope(),
    type: 'workflow_surface_changed',
    payload: summary,
  });
}

function publishCleared(
  publicBus: RuntimeEventBusService,
  lastBySurfaceId: Map<number, string>,
  surfaceId: number,
) {
  lastBySurfaceId.delete(surfaceId);
  return publicBus.publish({
    ...nextRuntimeEventEnvelope(),
    type: 'workflow_surface_cleared',
    payload: { surfaceId },
  });
}
