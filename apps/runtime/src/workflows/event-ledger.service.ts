import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Context, Data, Effect, Layer, Schema } from 'effect';

import {
  workflowEventSchema,
  type WorkflowEvent,
  type WorkflowLifecycleEvent,
  type WorkflowLogLevelDto,
  type WorkflowUiFeedbackDto,
} from '@isagi/contracts';

import { DataDirectory, type DatabaseError } from '../persistence/index.js';
import { InternalRuntimeEventBus } from '../runtime-events/index.js';
import { WorkflowRepository, type WorkflowRepositoryService } from './repository.js';
import type { WorkflowRunRow } from './types.js';

export class WorkflowEventLedgerError extends Data.TaggedError('WorkflowEventLedgerError')<{
  readonly code:
    | 'event_append_failed'
    | 'event_read_failed'
    | 'event_cleanup_failed'
    | 'event_sweep_failed';
  readonly runId?: number | undefined;
  readonly rootRunId?: number | undefined;
  readonly surfaceId?: number | undefined;
  readonly path?: string | undefined;
  readonly cause: unknown;
}> {}

export type WorkflowEventPayload =
  | {
      readonly type: 'log';
      readonly level: WorkflowLogLevelDto;
      readonly message: string;
    }
  | ({
      readonly type: 'ui_feedback';
    } & WorkflowUiFeedbackDto)
  | {
      readonly type: 'lifecycle';
      readonly event: WorkflowLifecycleEvent;
    };

export interface WorkflowEventAppendInput {
  readonly runId: number;
  readonly rootRunId: number | null;
  readonly surfaceId: number | null;
  readonly event: WorkflowEventPayload;
}

export interface WorkflowEventLedgerService {
  readonly append: (
    input: WorkflowEventAppendInput,
  ) => Effect.Effect<WorkflowEvent, WorkflowEventLedgerError>;
  readonly readSurfaceEvents: (
    surfaceId: number,
  ) => Effect.Effect<readonly WorkflowEvent[], WorkflowEventLedgerError | DatabaseError>;
  readonly latestUiFeedbackForRunTree: (
    rootRunId: number,
  ) => Effect.Effect<WorkflowUiFeedbackDto | undefined, WorkflowEventLedgerError | DatabaseError>;
  readonly deleteRunTreeLedgers: (
    rootRunId: number,
  ) => Effect.Effect<void, WorkflowEventLedgerError | DatabaseError>;
  readonly collectOrphans: Effect.Effect<void, WorkflowEventLedgerError | DatabaseError>;
  // Tear down run trees whose surface was deleted out from under them (surface_id
  // is now null). Runs waiting on the surface's torn-down agent turns can never
  // make progress, so we delete the rows + ledgers rather than let them linger.
  readonly sweepSurfaceDeletedRuns: Effect.Effect<void, WorkflowEventLedgerError | DatabaseError>;
  readonly pathForRun: (runId: number) => string;
}

export const WorkflowEventLedger = Context.GenericTag<WorkflowEventLedgerService>(
  'isagi/WorkflowEventLedger',
);

export const WorkflowEventLedgerLive = Layer.effect(
  WorkflowEventLedger,
  Effect.gen(function* () {
    const directory = yield* DataDirectory;
    const repository = yield* WorkflowRepository;
    const eventBus = yield* InternalRuntimeEventBus;
    const root = join(directory.paths.sessionsPath, 'workflow-runs');

    const service: WorkflowEventLedgerService = {
      append: (input) =>
        Effect.gen(function* () {
          const event = {
            ts: new Date().toISOString(),
            runId: input.runId,
            ...input.event,
          } satisfies WorkflowEvent;
          const path = eventPath(root, input.runId);
          yield* Effect.tryPromise({
            try: async () => {
              mkdirSync(runDirectory(root, input.runId), { recursive: true });
              await appendFile(path, `${JSON.stringify(event)}\n`, 'utf8');
            },
            catch: (cause) =>
              new WorkflowEventLedgerError({
                code: 'event_append_failed',
                runId: input.runId,
                rootRunId: input.rootRunId ?? undefined,
                surfaceId: input.surfaceId ?? undefined,
                path,
                cause,
              }),
          });
          yield* eventBus.publish({
            type: 'workflow_event_appended',
            surfaceId: input.surfaceId,
            rootRunId: input.rootRunId,
            runId: input.runId,
            event,
          });
          return event;
        }),
      readSurfaceEvents: (surfaceId) =>
        Effect.gen(function* () {
          const rootRun = yield* repository.findLatestRootRunForSurface(surfaceId);
          if (!rootRun?.rootRunId) return [];
          return yield* readRunTreeEvents(root, repository, rootRun.rootRunId);
        }),
      latestUiFeedbackForRunTree: (rootRunId) =>
        Effect.gen(function* () {
          const events = yield* readRunTreeEvents(root, repository, rootRunId);
          return latestUiFeedback(events);
        }),
      deleteRunTreeLedgers: (rootRunId) =>
        Effect.gen(function* () {
          const runs = yield* repository.listRunTree(rootRunId);
          for (const run of runs) {
            yield* removeRunDirectory(root, run.id);
          }
        }),
      collectOrphans: Effect.gen(function* () {
        const ids = yield* listLedgerRunIds(root);
        for (const runId of ids) {
          const run = yield* repository.findRun(runId);
          if (!run) yield* removeRunDirectory(root, runId);
        }

        yield* service.sweepSurfaceDeletedRuns;
      }).pipe(
        Effect.mapError(
          (cause) =>
            new WorkflowEventLedgerError({
              code: 'event_sweep_failed',
              cause,
            }),
        ),
      ),
      sweepSurfaceDeletedRuns: Effect.gen(function* () {
        const surfaceDeletedRoots = yield* repository.listSurfaceDeletedRootRuns;
        for (const run of surfaceDeletedRoots) {
          if (!run.rootRunId) continue;
          yield* service.deleteRunTreeLedgers(run.rootRunId);
          yield* repository.deleteRunTree({ rootRunId: run.rootRunId, surfaceId: null });
        }
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof WorkflowEventLedgerError
            ? cause
            : new WorkflowEventLedgerError({ code: 'event_sweep_failed', cause }),
        ),
      ),
      pathForRun: (runId) => eventPath(root, runId),
    };

    yield* service.collectOrphans.pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => {
          console.warn(
            '[runtime] Workflow event ledger orphan sweep failed',
            warningPayload(error),
          );
        }),
      ),
    );

    return service;
  }),
);

function readRunTreeEvents(root: string, repository: WorkflowRepositoryService, rootRunId: number) {
  return Effect.gen(function* () {
    const runs = yield* repository.listRunTree(rootRunId);
    const reads = yield* Effect.all(runs.map((run) => readRunEvents(root, run)));
    return reads
      .flat()
      .sort(compareIndexedEvents)
      .map(({ event }) => event);
  });
}

function readRunEvents(root: string, run: WorkflowRunRow) {
  const path = eventPath(root, run.id);
  return Effect.try({
    try: () => {
      let raw: string;
      try {
        raw = readFileSync(path, 'utf8');
      } catch (error) {
        if (isMissingFileError(error)) return [];
        throw error;
      }

      const events: IndexedWorkflowEvent[] = [];
      let ignoredLineCount = 0;
      let lineIndex = 0;
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const parsed = parseWorkflowEvent(line);
        if (parsed) {
          events.push({ event: parsed, lineIndex });
        } else {
          ignoredLineCount += 1;
        }
        lineIndex += 1;
      }
      if (ignoredLineCount > 0) {
        console.warn('[runtime] Workflow event ledger skipped malformed lines', {
          runId: run.id,
          rootRunId: run.rootRunId,
          surfaceId: run.surfaceId,
          path,
          ignoredLineCount,
        });
      }
      return events;
    },
    catch: (cause) =>
      new WorkflowEventLedgerError({
        code: 'event_read_failed',
        runId: run.id,
        rootRunId: run.rootRunId ?? undefined,
        surfaceId: run.surfaceId ?? undefined,
        path,
        cause,
      }),
  });
}

function removeRunDirectory(root: string, runId: number) {
  const directory = runDirectory(root, runId);
  return Effect.try({
    try: () => {
      rmSync(directory, { recursive: true, force: true });
    },
    catch: (cause) =>
      new WorkflowEventLedgerError({
        code: 'event_cleanup_failed',
        runId,
        path: directory,
        cause,
      }),
  });
}

function listLedgerRunIds(root: string) {
  return Effect.try({
    try: () => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = readdirSync(root, { withFileTypes: true });
      } catch (error) {
        if (isMissingFileError(error)) return [];
        throw error;
      }
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => Number(entry.name))
        .filter((runId) => Number.isSafeInteger(runId) && runId > 0);
    },
    catch: (cause) =>
      new WorkflowEventLedgerError({
        code: 'event_sweep_failed',
        path: root,
        cause,
      }),
  });
}

function parseWorkflowEvent(line: string): WorkflowEvent | null {
  try {
    return Schema.decodeUnknownSync(workflowEventSchema)(JSON.parse(line));
  } catch {
    return null;
  }
}

function latestUiFeedback(events: readonly WorkflowEvent[]): WorkflowUiFeedbackDto | undefined {
  const latest = [...events].filter((event) => event.type === 'ui_feedback').at(-1);
  if (!latest || latest.type !== 'ui_feedback') return undefined;
  const { type: _type, ts: _ts, runId: _runId, ...feedback } = latest;
  return feedback;
}

interface IndexedWorkflowEvent {
  readonly event: WorkflowEvent;
  readonly lineIndex: number;
}

function compareIndexedEvents(left: IndexedWorkflowEvent, right: IndexedWorkflowEvent) {
  const ts = left.event.ts.localeCompare(right.event.ts);
  if (ts !== 0) return ts;
  const runId = left.event.runId - right.event.runId;
  if (runId !== 0) return runId;
  return left.lineIndex - right.lineIndex;
}

function runDirectory(root: string, runId: number) {
  return join(root, String(runId));
}

function eventPath(root: string, runId: number) {
  return join(runDirectory(root, runId), 'events.jsonl');
}

function isMissingFileError(error: unknown) {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT',
  );
}

export function workflowEventLedgerWarningPayload(error: unknown) {
  return warningPayload(error);
}

function warningPayload(error: unknown) {
  if (!(error instanceof WorkflowEventLedgerError)) {
    return { cause: error };
  }
  return {
    code: error.code,
    runId: error.runId,
    rootRunId: error.rootRunId,
    surfaceId: error.surfaceId,
    path: error.path,
    cause: error.cause,
  };
}
