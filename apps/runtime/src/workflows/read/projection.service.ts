import { and, asc, desc, eq, gt, or, sql, type SQL } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import type {
  GetWorkflowAttemptOutput,
  GetWorkflowPayloadOutput,
  GetWorkflowRunOutput,
  GetWorkflowStructureOutput,
  ListFrameExecutionsOutput,
  ListFrameExecutionsQuery,
  ListRunExecutionsOutput,
  ListRunExecutionsQuery,
  ListWorkflowAttemptsOutput,
  ListWorkflowAttemptsQuery,
  ListWorkflowEventsOutput,
  ListWorkflowEventsQuery,
  ListWorkflowFramesOutput,
  ListWorkflowFramesQuery,
  ListWorkflowOperationsOutput,
  ListWorkflowOperationsQuery,
  ListWorkflowRunsOutput,
  ListWorkflowRunsQuery,
  ListWorkflowVersionsOutput,
  ListWorkflowVersionsQuery,
  WorkflowExecutionDto,
  WorkflowFrameDto,
  WorkflowOperationDto,
  WorkflowRunSummary,
  WorkflowStructureQuery,
} from '@isagi/contracts';

import type { RuntimeDrizzleDatabase } from '../../persistence/database.service.js';
import { DatabaseError, RuntimeDatabase } from '../../persistence/index.js';
import {
  workflowArtifacts,
  workflowGraphFrames,
  workflowNodeExecutions,
  workflowOperations,
  workflowRunAttachments,
  workflowPayloads,
  workflowRuns,
  workflowSegmentAttempts,
  workflowVersionAdoptions,
} from '../../persistence/schema.js';
import {
  WorkflowPayloadStore,
  type WorkflowPayloadStoreService,
} from '../persistence/payload-store.js';
import { slotFromColumns } from '../persistence/slots.js';
import { WorkflowEngineError } from '../types.js';
import {
  boundaryFor,
  callPositionKey,
  decodeCursor,
  decodeSnapshotToken,
  encodeCursor,
  revisionKey,
  startedAtKey,
  WorkflowCursorRejected,
  type CursorBinding,
} from './cursors.js';
import { baselineExecutions, boundaryOf, recoveredExecutions } from './executions.js';
import { payloadBelongsToRun } from './payload-access.js';
import { attemptDto, versionDto } from './project/records.js';
import { deltaPage, recordsAt, summaryAt } from './snapshots.js';

/**
 * The retained read surface.
 *
 * Every route reads durable records and nothing else: opening an inspector launches no work, imports
 * no historical code, reconciles no operation and repairs no state. Paginated reads freeze a
 * high-water revision and stay on it, so a page cannot silently mix two moments of a run, and the
 * coverage a response reports is only ever the history it actually delivered.
 */

const defaultPageLimit = 100;

export interface WorkflowRunProjectionService {
  readonly listRuns: (
    query: ListWorkflowRunsQuery,
  ) => Effect.Effect<ListWorkflowRunsOutput, ReadFailure>;
  readonly getRun: (runId: number) => Effect.Effect<GetWorkflowRunOutput, ReadFailure>;
  readonly getStructure: (
    runId: number,
    query: WorkflowStructureQuery,
  ) => Effect.Effect<GetWorkflowStructureOutput, ReadFailure>;
  readonly listVersions: (
    runId: number,
    query: ListWorkflowVersionsQuery,
  ) => Effect.Effect<ListWorkflowVersionsOutput, ReadFailure>;
  readonly listFrames: (
    runId: number,
    query: ListWorkflowFramesQuery,
  ) => Effect.Effect<ListWorkflowFramesOutput, ReadFailure>;
  readonly listFrameExecutions: (
    runId: number,
    frameId: number,
    query: ListFrameExecutionsQuery,
  ) => Effect.Effect<ListFrameExecutionsOutput, ReadFailure>;
  readonly listRunExecutions: (
    runId: number,
    query: ListRunExecutionsQuery,
  ) => Effect.Effect<ListRunExecutionsOutput, ReadFailure>;
  readonly listAttempts: (
    runId: number,
    query: ListWorkflowAttemptsQuery,
  ) => Effect.Effect<ListWorkflowAttemptsOutput, ReadFailure>;
  readonly getAttempt: (
    runId: number,
    attemptId: number,
  ) => Effect.Effect<GetWorkflowAttemptOutput, ReadFailure>;
  readonly listOperations: (
    runId: number,
    query: ListWorkflowOperationsQuery,
  ) => Effect.Effect<ListWorkflowOperationsOutput, ReadFailure>;
  readonly listEvents: (
    runId: number,
    query: ListWorkflowEventsQuery,
  ) => Effect.Effect<ListWorkflowEventsOutput, ReadFailure>;
  readonly getPayload: (
    runId: number,
    payloadRef: string,
  ) => Effect.Effect<GetWorkflowPayloadOutput, ReadFailure>;
  /**
   * The summaries surface bookkeeping needs: every run currently occupying a surface.
   *
   * This is what `workflow_run_snapshot` carries on connect. It is not an alternate authority for a
   * run's state — the revision deltas and the read routes are — and it never pages, because an
   * attachment is unique per surface and therefore inherently bounded.
   */
  readonly listAttachedSummaries: () => Effect.Effect<readonly WorkflowRunSummary[], ReadFailure>;
  /** The current summary, straight from the durable read model. Used by the delta publisher. */
  readonly summaryOf: (runId: number) => Effect.Effect<WorkflowRunSummary | null, ReadFailure>;
}

export type ReadFailure = WorkflowEngineError | DatabaseError;

export const WorkflowRunProjection = Context.GenericTag<WorkflowRunProjectionService>(
  'isagi/WorkflowRunProjection',
);

export const WorkflowRunProjectionLive = Layer.effect(
  WorkflowRunProjection,
  Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    const payloads = yield* WorkflowPayloadStore;
    return makeWorkflowRunProjection(database, payloads);
  }),
);

export function makeWorkflowRunProjection(
  database: Pick<
    import('../../persistence/index.js').RuntimeDatabaseService,
    'use' | 'transaction'
  >,
  payloads: WorkflowPayloadStoreService,
): WorkflowRunProjectionService {
  /**
   * One read, one consistent view.
   *
   * SQLite serializes writers, so a single `use` sees one committed state; freezing the boundary
   * inside it is what makes "the revision this page was taken against" a fact rather than a guess.
   * No transaction is held across requests — a continuation re-derives the same view from the
   * revision its cursor carries.
   */
  const read = <A>(
    operation: string,
    execute: (db: RuntimeDrizzleDatabase) => A,
  ): Effect.Effect<A, ReadFailure> =>
    database.use(operation, execute).pipe(
      // A rejection raised inside the closure is a domain answer, not a database fault. `use` wraps
      // whatever the closure throws, so the intended failure is unwrapped again here rather than
      // being reported to a client as an internal error.
      Effect.catchTag(
        'DatabaseError',
        (error): Effect.Effect<never, ReadFailure> =>
          error.cause instanceof WorkflowEngineError
            ? Effect.fail(error.cause)
            : error.cause instanceof WorkflowCursorRejected
              ? cursorRejected()
              : Effect.fail(error),
      ),
    );

  const requireRun = (db: RuntimeDrizzleDatabase, runId: number) => {
    const row = db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get();
    if (!row) throw runNotFound(runId);
    return row;
  };

  return {
    listRuns: (query) =>
      read('workflow_list_runs', (db) => {
        const filters = {
          workflowKey: query.workflowKey,
          status: query.status,
          attachedWorktreeId: query.attachedWorktreeId,
          attachedSurfaceId: query.attachedSurfaceId,
          includeDismissed: booleanQuery(query.includeDismissed) ?? true,
        };
        const binding: CursorBinding = {
          route: 'workflows.listRuns',
          runId: null,
          filters,
          key: revisionKey,
        };
        const limit = limitOf(query.limit);
        const key = query.cursor === undefined ? null : decodeCursor(query.cursor, binding).key;
        const predicates: SQL[] = [];
        if (filters.workflowKey !== undefined) {
          predicates.push(eq(workflowRuns.workflowKey, filters.workflowKey));
        }
        if (filters.status !== undefined) predicates.push(eq(workflowRuns.status, filters.status));
        if (key !== null) predicates.push(sql`${workflowRuns.id} < ${Number(key[0])}`);

        // Attachment filters are the surface-occupancy question, and they are the only reason this
        // listing touches an environment-lifetime row. A run with no attachment is still listed by
        // default: losing a place to show a run is not losing the run. The join is what applies
        // occupancy, so a page is never shortened after the fact by a filter the query could state.
        const attached =
          filters.attachedWorktreeId !== undefined ||
          filters.attachedSurfaceId !== undefined ||
          !filters.includeDismissed;
        const rows = attached
          ? db
              .select({ run: workflowRuns })
              .from(workflowRuns)
              .innerJoin(workflowRunAttachments, eq(workflowRunAttachments.runId, workflowRuns.id))
              .where(
                and(
                  ...predicates,
                  ...(filters.attachedWorktreeId === undefined
                    ? []
                    : [eq(workflowRunAttachments.worktreeId, filters.attachedWorktreeId)]),
                  ...(filters.attachedSurfaceId === undefined
                    ? []
                    : [eq(workflowRunAttachments.surfaceId, filters.attachedSurfaceId)]),
                ),
              )
              .orderBy(desc(workflowRuns.id))
              .limit(limit + 1)
              .all()
              .map((joined) => joined.run)
          : db
              .select()
              .from(workflowRuns)
              .where(predicates.length === 0 ? undefined : and(...predicates))
              .orderBy(desc(workflowRuns.id))
              .limit(limit + 1)
              .all();

        const page = rows.slice(0, limit);
        const items = page
          .map((row) => summaryAt(db, row.id, row.revision))
          .filter((summary): summary is WorkflowRunSummary => summary !== null);
        return {
          items,
          nextCursor:
            rows.length > limit && page.at(-1) ? encodeCursor(binding, [page.at(-1)!.id]) : null,
        };
      }),

    getRun: (runId) =>
      read('workflow_get_run', (db) => {
        const row = requireRun(db, runId);
        const summary = summaryAt(db, row.id, row.revision);
        if (!summary) throw runNotFound(runId);
        return { run: summary };
      }),

    getStructure: (runId, query) =>
      Effect.gen(function* () {
        const resolved = yield* read('workflow_get_structure', (db) => {
          const run = requireRun(db, runId);
          const artifactHash = query.artifactHash ?? run.artifactHash;
          const adoptions = db
            .select()
            .from(workflowVersionAdoptions)
            .where(eq(workflowVersionAdoptions.runId, runId))
            .orderBy(asc(workflowVersionAdoptions.id))
            .all();
          const ordinal = adoptions.findLastIndex(
            (adoption) => adoption.artifactHash === artifactHash,
          );
          if (ordinal < 0) {
            throw new WorkflowEngineError({
              code: 'workflow_version_not_adopted',
              message: `Run ${runId} never adopted version ${artifactHash}.`,
              workflowRunId: runId,
              artifactHash,
            });
          }
          const artifact = db
            .select()
            .from(workflowArtifacts)
            .where(eq(workflowArtifacts.artifactHash, artifactHash))
            .get();
          if (!artifact) {
            throw new WorkflowEngineError({
              code: 'workflow_version_not_adopted',
              message: `Version ${artifactHash} is no longer described in the artifact catalog.`,
              workflowRunId: runId,
              artifactHash,
            });
          }
          return {
            artifact,
            adoptedAt: adoptions[ordinal]!.adoptedAt,
            pinOrdinal: ordinal + 1,
            // Read from the catalog row, never by importing the version's code: an old definition is
            // inspectable long after nothing can load it.
            descriptorSlot: slotFromColumns(
              'workflow_artifacts.descriptor',
              artifact.descriptorInline,
              artifact.descriptorRef,
            ),
          };
        });
        const descriptor =
          resolved.descriptorSlot === null
            ? null
            : yield* payloads
                .resolve(resolved.descriptorSlot)
                .pipe(Effect.catchTag('PayloadUnavailable', payloadUnavailable(runId)));
        if (descriptor === null) {
          return yield* Effect.fail(
            new WorkflowEngineError({
              code: 'workflow_version_not_adopted',
              message: `Version ${resolved.artifact.artifactHash} has no stored structural descriptor.`,
              workflowRunId: runId,
              artifactHash: resolved.artifact.artifactHash,
            }),
          );
        }
        return {
          artifactHash: resolved.artifact.artifactHash,
          workflowKey: resolved.artifact.workflowKey,
          sdkVersion: resolved.artifact.sdkVersion,
          verifierVersion: resolved.artifact.verifierVersion,
          pinOrdinal: resolved.pinOrdinal,
          adoptedAt: resolved.adoptedAt,
          descriptor: descriptor as GetWorkflowStructureOutput['descriptor'],
        };
      }),

    listVersions: (runId, query) =>
      read('workflow_list_versions', (db) => {
        requireRun(db, runId);
        const binding: CursorBinding = {
          route: 'workflows.listVersions',
          runId,
          filters: {},
          key: revisionKey,
        };
        const limit = limitOf(query.limit);
        const key = query.cursor === undefined ? null : decodeCursor(query.cursor, binding).key;
        const rows = db
          .select()
          .from(workflowVersionAdoptions)
          .where(
            and(
              eq(workflowVersionAdoptions.runId, runId),
              ...(key === null ? [] : [gt(workflowVersionAdoptions.id, Number(key[0]))]),
            ),
          )
          .orderBy(asc(workflowVersionAdoptions.id))
          .limit(limit + 1)
          .all();
        const page = rows.slice(0, limit);
        // The ordinal is the adoption's place in the whole history, not its place on this page.
        const before = db
          .select({ value: sql<number>`count(*)` })
          .from(workflowVersionAdoptions)
          .where(
            and(
              eq(workflowVersionAdoptions.runId, runId),
              ...(page[0] ? [sql`${workflowVersionAdoptions.id} < ${page[0].id}`] : []),
            ),
          )
          .get();
        const offset = page[0] ? (before?.value ?? 0) : 0;
        const items = page.map((row, index) => {
          const artifact = db
            .select()
            .from(workflowArtifacts)
            .where(eq(workflowArtifacts.artifactHash, row.artifactHash))
            .get();
          return versionDto(row, offset + index + 1, {
            sdkVersion: artifact?.sdkVersion ?? '',
            verifierVersion: artifact?.verifierVersion ?? '',
            rootGraphKey: artifact?.rootGraphKey ?? '',
          });
        });
        return {
          items,
          nextCursor:
            rows.length > limit && page.at(-1) ? encodeCursor(binding, [page.at(-1)!.id]) : null,
        };
      }),

    listFrames: (runId, query) =>
      read('workflow_list_frames', (db) => {
        const run = requireRun(db, runId);
        const filters = { parentExecutionId: query.parentExecutionId };
        const binding: CursorBinding = {
          route: 'workflows.listFrames',
          runId,
          filters,
          key: revisionKey,
        };
        const limit = limitOf(query.limit);
        const key = query.cursor === undefined ? null : decodeCursor(query.cursor, binding).key;
        const rows = db
          .select({ id: workflowGraphFrames.id })
          .from(workflowGraphFrames)
          .where(
            and(
              eq(workflowGraphFrames.runId, runId),
              ...(filters.parentExecutionId === undefined
                ? []
                : [eq(workflowGraphFrames.parentExecutionId, filters.parentExecutionId)]),
              ...(key === null ? [] : [gt(workflowGraphFrames.id, Number(key[0]))]),
            ),
          )
          .orderBy(asc(workflowGraphFrames.id))
          .limit(limit + 1)
          .all();
        const page = rows.slice(0, limit);
        const frames = recordsAt<WorkflowFrameDto>(db, {
          runId,
          kind: 'frame',
          ids: page.map((row) => row.id),
          atRevision: run.revision,
        });
        return {
          items: page
            .map((row) => frames.get(row.id))
            .filter((frame): frame is WorkflowFrameDto => frame !== undefined),
          nextCursor:
            rows.length > limit && page.at(-1) ? encodeCursor(binding, [page.at(-1)!.id]) : null,
        };
      }),

    listFrameExecutions: (runId, frameId, query) =>
      read('workflow_list_frame_executions', (db) => {
        const run = requireRun(db, runId);
        const frame = db
          .select()
          .from(workflowGraphFrames)
          .where(eq(workflowGraphFrames.id, frameId))
          .get();
        if (!frame || frame.runId !== runId) {
          throw new WorkflowEngineError({
            code: 'workflow_run_not_found',
            message: `Frame ${frameId} does not belong to run ${runId}.`,
            workflowRunId: runId,
          });
        }
        const filters = { nodeId: query.nodeId };
        const binding: CursorBinding = {
          route: 'workflows.listFrameExecutions',
          runId,
          filters: { frameId, ...filters },
          key: revisionKey,
        };
        const limit = limitOf(query.limit);
        const key = query.cursor === undefined ? null : decodeCursor(query.cursor, binding).key;
        const rows = db
          .select({ id: workflowNodeExecutions.id })
          .from(workflowNodeExecutions)
          .where(
            and(
              eq(workflowNodeExecutions.frameId, frameId),
              ...(filters.nodeId === undefined
                ? []
                : [eq(workflowNodeExecutions.nodeId, filters.nodeId)]),
              ...(key === null ? [] : [gt(workflowNodeExecutions.id, Number(key[0]))]),
            ),
          )
          .orderBy(asc(workflowNodeExecutions.id))
          .limit(limit + 1)
          .all();
        const page = rows.slice(0, limit);
        const executions = recordsAt<WorkflowExecutionDto>(db, {
          runId,
          kind: 'execution',
          ids: page.map((row) => row.id),
          atRevision: run.revision,
        });
        return {
          items: page
            .map((row) => executions.get(row.id))
            .filter((execution): execution is WorkflowExecutionDto => execution !== undefined),
          nextCursor:
            rows.length > limit && page.at(-1) ? encodeCursor(binding, [page.at(-1)!.id]) : null,
        };
      }),

    listRunExecutions: (runId, query) =>
      read('workflow_list_run_executions', (db) => {
        const run = requireRun(db, runId);
        const since = query.sinceRevision;
        const limit = limitOf(query.limit);
        const binding: CursorBinding = {
          route: 'workflows.listExecutions',
          runId,
          filters: {},
          since,
          // Hydration pages by `(startedAt, executionId)`; gap recovery pages by revision. The two
          // are different listings of one route, and a cursor for one is not a cursor for the other.
          key: since === undefined ? startedAtKey : revisionKey,
        };
        const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor, binding);
        const highWater = boundaryFor({
          cursor,
          token:
            query.snapshotToken === undefined
              ? null
              : decodeSnapshotToken(query.snapshotToken, runId),
          current: run.revision,
        });
        const key = cursor?.key ?? null;
        return since === undefined
          ? baselineExecutions(db, { runId, highWater, limit, binding, key })
          : recoveredExecutions(db, { runId, since, highWater, limit, binding, key });
      }),

    listAttempts: (runId, query) =>
      read('workflow_list_attempts', (db) => {
        requireRun(db, runId);
        const filters = {
          frameId: query.frameId,
          executionId: query.executionId,
          segmentKind: query.segmentKind,
        };
        const binding: CursorBinding = {
          route: 'workflows.listAttempts',
          runId,
          filters,
          key: revisionKey,
        };
        const limit = limitOf(query.limit);
        const key = query.cursor === undefined ? null : decodeCursor(query.cursor, binding).key;
        const rows = db
          .select()
          .from(workflowSegmentAttempts)
          .where(
            and(
              eq(workflowSegmentAttempts.runId, runId),
              ...(filters.frameId === undefined
                ? []
                : [eq(workflowSegmentAttempts.frameId, filters.frameId)]),
              ...(filters.executionId === undefined
                ? []
                : [eq(workflowSegmentAttempts.executionId, filters.executionId)]),
              ...(filters.segmentKind === undefined
                ? []
                : [eq(workflowSegmentAttempts.segmentKind, filters.segmentKind)]),
              ...(key === null ? [] : [gt(workflowSegmentAttempts.id, Number(key[0]))]),
            ),
          )
          .orderBy(asc(workflowSegmentAttempts.id))
          .limit(limit + 1)
          .all();
        const page = rows.slice(0, limit);
        return {
          items: page.map((row) => attemptDto(db, row)),
          nextCursor:
            rows.length > limit && page.at(-1) ? encodeCursor(binding, [page.at(-1)!.id]) : null,
        };
      }),

    getAttempt: (runId, attemptId) =>
      read('workflow_get_attempt', (db) => {
        requireRun(db, runId);
        const row = db
          .select()
          .from(workflowSegmentAttempts)
          .where(eq(workflowSegmentAttempts.id, attemptId))
          .get();
        if (!row || row.runId !== runId) {
          throw new WorkflowEngineError({
            code: 'workflow_run_not_found',
            message: `Attempt ${attemptId} does not belong to run ${runId}.`,
            workflowRunId: runId,
          });
        }
        return { attempt: attemptDto(db, row) };
      }),

    listOperations: (runId, query) =>
      read('workflow_list_operations', (db) => {
        const run = requireRun(db, runId);
        const filters = { executionId: query.executionId, state: query.state };
        const binding: CursorBinding = {
          route: 'workflows.listOperations',
          runId,
          filters,
          key: callPositionKey,
        };
        const limit = limitOf(query.limit);
        const key = query.cursor === undefined ? null : decodeCursor(query.cursor, binding).key;
        // `(execution, call index)` is the durable call position and is uniquely indexed, so it is
        // both the honest order — every call a visit made, across attempts — and a stable cursor.
        const rows = db
          .select({
            id: workflowOperations.id,
            executionId: workflowOperations.executionId,
            callIndex: workflowOperations.callIndex,
          })
          .from(workflowOperations)
          .where(
            and(
              eq(workflowOperations.runId, runId),
              ...(filters.executionId === undefined
                ? []
                : [eq(workflowOperations.executionId, filters.executionId)]),
              ...(filters.state === undefined ? [] : [eq(workflowOperations.state, filters.state)]),
              ...(key === null
                ? []
                : [
                    or(
                      gt(workflowOperations.executionId, Number(key[0])),
                      and(
                        eq(workflowOperations.executionId, Number(key[0])),
                        gt(workflowOperations.callIndex, Number(key[1])),
                      ),
                    )!,
                  ]),
            ),
          )
          .orderBy(asc(workflowOperations.executionId), asc(workflowOperations.callIndex))
          .limit(limit + 1)
          .all();
        const page = rows.slice(0, limit);
        const operations = recordsAt<WorkflowOperationDto>(db, {
          runId,
          kind: 'operation',
          ids: page.map((row) => row.id),
          atRevision: run.revision,
        });
        const last = page.at(-1);
        return {
          items: page
            .map((row) => operations.get(row.id))
            .filter((operation): operation is WorkflowOperationDto => operation !== undefined),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor(binding, [last.executionId, last.callIndex])
              : null,
        };
      }),

    listEvents: (runId, query) =>
      read('workflow_list_events', (db) => {
        const run = requireRun(db, runId);
        const since = query.sinceRevision ?? 0;
        const limit = limitOf(query.limit);
        const binding: CursorBinding = {
          route: 'workflows.listEvents',
          runId,
          filters: {},
          since: query.sinceRevision,
          key: revisionKey,
        };
        const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor, binding);
        const highWater = boundaryFor({
          cursor,
          token:
            query.snapshotToken === undefined
              ? null
              : decodeSnapshotToken(query.snapshotToken, runId),
          current: run.revision,
        });
        const from = cursor === null ? since : Number(cursor.key[0]);
        const items = deltaPage(db, { runId, since: from, atRevision: highWater, limit });
        const last = items.at(-1);
        const coverage = last?.revision ?? from;
        const complete = coverage >= highWater;
        return {
          items,
          nextCursor: complete ? null : encodeCursor(binding, [coverage], highWater),
          boundary: boundaryOf(runId, highWater, coverage, complete),
        };
      }),

    getPayload: (runId, payloadRef) =>
      Effect.gen(function* () {
        yield* read('workflow_authorize_payload', (db) => {
          requireRun(db, runId);
          if (!payloadBelongsToRun(db, runId, payloadRef)) {
            // Scoped to the run on purpose: this is not a general content-read endpoint, and a
            // reference this run never recorded is not one it can serve.
            throw new WorkflowEngineError({
              code: 'workflow_payload_unavailable',
              message: `Run ${runId} does not reference payload ${payloadRef}.`,
              workflowRunId: runId,
              payloadRef,
              payloadCause: 'missing',
            });
          }
          return true;
        });
        const value = yield* payloads
          .read(payloadRef)
          .pipe(Effect.catchTag('PayloadUnavailable', payloadUnavailable(runId)));
        const meta = yield* read('workflow_read_payload_meta', (db) =>
          db
            .select()
            .from(workflowPayloads)
            .where(eq(workflowPayloads.payloadRef, payloadRef))
            .get(),
        );
        return {
          payloadRef,
          mediaType: meta?.mediaType ?? 'application/json',
          byteSize: meta?.byteSize ?? 0,
          value,
        };
      }),

    listAttachedSummaries: () =>
      read('workflow_list_attached_summaries', (db) => {
        const rows = db
          .select({ id: workflowRuns.id, revision: workflowRuns.revision })
          .from(workflowRuns)
          .innerJoin(workflowRunAttachments, eq(workflowRunAttachments.runId, workflowRuns.id))
          .orderBy(asc(workflowRuns.id))
          .all();
        return rows
          .map((row) => summaryAt(db, row.id, row.revision))
          .filter((summary): summary is WorkflowRunSummary => summary !== null);
      }),

    summaryOf: (runId) =>
      read('workflow_summary_of', (db) => {
        const row = db
          .select({ revision: workflowRuns.revision })
          .from(workflowRuns)
          .where(eq(workflowRuns.id, runId))
          .get();
        return row ? summaryAt(db, runId, row.revision) : null;
      }),
  };
}

function limitOf(limit: number | undefined): number {
  return limit ?? defaultPageLimit;
}

function booleanQuery(value: boolean | 'true' | 'false' | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value === true || value === 'true';
}

function runNotFound(runId: number) {
  return new WorkflowEngineError({
    code: 'workflow_run_not_found',
    message: `Workflow run ${runId} was not found.`,
    workflowRunId: runId,
  });
}

function cursorRejected() {
  return Effect.fail(
    new WorkflowEngineError({
      code: 'workflow_cursor_invalid',
      // Deliberately says nothing about the cursor's contents: which binding failed is a runtime
      // detail, and the client's recovery is the same in every case.
      message: 'This pagination cursor is not one this listing will continue.',
    }),
  );
}

function payloadUnavailable(runId: number) {
  return (error: { readonly ref: string; readonly cause: 'missing' | 'corrupt' }) =>
    Effect.fail(
      new WorkflowEngineError({
        code: 'workflow_payload_unavailable',
        message:
          error.cause === 'missing'
            ? `Recorded value ${error.ref} is no longer stored.`
            : `Recorded value ${error.ref} no longer matches its reference.`,
        workflowRunId: runId,
        payloadRef: error.ref,
        payloadCause: error.cause,
      }),
    );
}
