import { posix } from 'node:path';
import type { Readable } from 'node:stream';

import { aliasedTable, and, asc, desc, eq, gt, or, sql, type SQL } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import type {
  AgentHarness,
  GetWorkflowAttemptOutput,
  GetWorkflowCheckpointOutput,
  GetWorkflowEvidenceOutput,
  GetWorkflowOperationOutput,
  GetWorkflowPayloadOutput,
  GetWorkflowRunOutput,
  GetWorkflowStructureOutput,
  ListFrameExecutionsOutput,
  ListFrameExecutionsQuery,
  ListRunExecutionsOutput,
  ListRunExecutionsQuery,
  ListWorkflowAttemptsOutput,
  ListWorkflowAttemptsQuery,
  ListWorkflowCheckpointInventoryOutput,
  ListWorkflowCheckpointManifestOutput,
  ListWorkflowCheckpointsOutput,
  ListWorkflowCheckpointsQuery,
  ListWorkflowEventsOutput,
  ListWorkflowEventsQuery,
  ListWorkflowEvidenceOutput,
  ListWorkflowEvidenceQuery,
  ListWorkflowFramesOutput,
  ListWorkflowFramesQuery,
  ListWorkflowOperationsOutput,
  ListWorkflowOperationsQuery,
  ListWorkflowRunsOutput,
  ListWorkflowRunsQuery,
  ListWorkflowVersionsOutput,
  ListWorkflowVersionsQuery,
  PaginationQuery,
  WorkflowExecutionDto,
  WorkflowFrameDto,
  WorkflowOperationDto,
  WorkflowRunSummary,
  WorkflowStructureQuery,
} from '@isagi/contracts';

import { harnessDefinition } from '../../agent-sessions/harness/definitions.js';
import type { RuntimeDrizzleDatabase } from '../../persistence/database.service.js';
import { DatabaseError, RuntimeDatabase } from '../../persistence/index.js';
import {
  workflowArtifacts,
  workflowCheckpoints,
  workflowEvidence,
  workflowGraphFrames,
  workflowNodeExecutions,
  workflowOperations,
  workflowRunAttachments,
  workflowPayloads,
  workflowRuns,
  workflowSegmentAttempts,
  workflowVersionAdoptions,
} from '../../persistence/schema.js';
import { extensionForMediaType } from '../evidence/media-types.js';
import {
  WorkflowContentStore,
  type WorkflowContentStoreService,
} from '../persistence/content-store.js';
import {
  WorkflowPayloadStore,
  workflowPayloadMediaType,
  type WorkflowPayloadStoreService,
} from '../persistence/payload-store.js';
import { checkpointRecord } from '../persistence/row-mappers.js';
import { slotFromColumns } from '../persistence/slots.js';
import { WorkflowEngineError } from '../types.js';
import {
  boundaryFor,
  callPositionKey,
  decodeCursor,
  decodeSnapshotToken,
  encodeCursor,
  layerEntryKey,
  revisionKey,
  startedAtKey,
  WorkflowCursorRejected,
  type CursorBinding,
} from './cursors.js';
import { baselineExecutions, boundaryOf, recoveredExecutions } from './executions.js';
import { payloadBelongsToRun } from './payload-access.js';
import {
  checkpointDto,
  checkpointFileInRun,
  checkpointInRun,
  checkpointSummaryDto,
  inventoryPage,
  manifestPage,
} from './project/checkpoints.js';
import {
  evidenceDto,
  labelPredicates,
  parseLabelFilters,
  subtreeExecutionIds,
} from './project/evidence.js';
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
  readonly listEvidence: (
    runId: number,
    query: ListWorkflowEvidenceQuery,
  ) => Effect.Effect<ListWorkflowEvidenceOutput, ReadFailure>;
  readonly getEvidence: (
    runId: number,
    evidenceKey: string,
  ) => Effect.Effect<GetWorkflowEvidenceOutput, ReadFailure>;
  /**
   * The bytes of one captured record, verified and ready to stream.
   *
   * Authorized by the evidence row's own run, not through `payload-access.ts`: a content reference
   * is not a payload slot, and the payload route's JSON decode would mis-report a PNG as corrupt.
   */
  readonly openEvidenceContent: (
    runId: number,
    evidenceKey: string,
  ) => Effect.Effect<WorkflowContentResponse, ReadFailure>;
  /** A run's saved checkpoints, oldest first, optionally narrowed to one visit or its subtree. */
  readonly listCheckpoints: (
    runId: number,
    query: ListWorkflowCheckpointsQuery,
  ) => Effect.Effect<ListWorkflowCheckpointsOutput, ReadFailure>;
  /** One checkpoint's stored facts. Probes neither Git nor the filesystem. */
  readonly getCheckpoint: (
    runId: number,
    checkpointId: string,
  ) => Effect.Effect<GetWorkflowCheckpointOutput, ReadFailure>;
  /** One page of a checkpoint's already-resolved final state. */
  readonly listCheckpointInventory: (
    runId: number,
    checkpointId: string,
    query: PaginationQuery,
  ) => Effect.Effect<ListWorkflowCheckpointInventoryOutput, ReadFailure>;
  /** One page of a checkpoint's lineage: each layer's own scopes, changes and observations. */
  readonly listCheckpointManifest: (
    runId: number,
    checkpointId: string,
    query: PaginationQuery,
  ) => Effect.Effect<ListWorkflowCheckpointManifestOutput, ReadFailure>;
  /** The verified bytes of one saved file, authorized by its checkpoint's run. */
  readonly openCheckpointFileContent: (
    runId: number,
    checkpointId: string,
    fileId: string,
  ) => Effect.Effect<WorkflowContentResponse, ReadFailure>;
  /**
   * One operation with its provenance, including the transcript locator every other route omits.
   *
   * This is the only read that may touch the filesystem, and it does so outside the database read.
   */
  readonly getOperation: (
    runId: number,
    operationKey: string,
  ) => Effect.Effect<GetWorkflowOperationOutput, ReadFailure>;
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

/**
 * What a content route needs to serve stored bytes: an evidence record or a checkpoint file.
 *
 * Structurally identical to `ContentResponse` in `lib/api/content-endpoint.ts`, and restated rather
 * than imported so the read layer keeps no dependency on the HTTP layer. The two must change
 * together; each names the other so that is discoverable rather than discovered.
 */
export interface WorkflowContentResponse {
  readonly stream: Readable;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly filename: string;
}

/**
 * Where a harness's native transcript for one operation would be.
 *
 * Injected rather than imported at the call site so the read layer's single dependency on the
 * harness registry is one function a test can replace — and so `getOperation` stays the only read
 * that can reach a filesystem at all.
 */
export interface TranscriptLocator {
  (input: {
    readonly harness: AgentHarness;
    readonly harnessSessionId: string;
    readonly cwd: string;
  }): Effect.Effect<{ readonly locator: string; readonly available: boolean } | null>;
}

const registryTranscriptLocator: TranscriptLocator = (input) =>
  harnessDefinition(input.harness).observation.locateTranscript?.({
    harnessSessionId: input.harnessSessionId,
    cwd: input.cwd,
  }) ?? Effect.succeed(null);

export interface WorkflowRunProjectionOptions {
  readonly locateTranscript?: TranscriptLocator | undefined;
}

export const WorkflowRunProjection = Context.GenericTag<WorkflowRunProjectionService>(
  'isagi/WorkflowRunProjection',
);

export const WorkflowRunProjectionLive = Layer.effect(
  WorkflowRunProjection,
  Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    const payloads = yield* WorkflowPayloadStore;
    const content = yield* WorkflowContentStore;
    return makeWorkflowRunProjection(database, payloads, content);
  }),
);

export function makeWorkflowRunProjection(
  database: Pick<
    import('../../persistence/index.js').RuntimeDatabaseService,
    'use' | 'transaction'
  >,
  payloads: WorkflowPayloadStoreService,
  content: WorkflowContentStoreService,
  options: WorkflowRunProjectionOptions = {},
): WorkflowRunProjectionService {
  const locateTranscript = options.locateTranscript ?? registryTranscriptLocator;
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
                .pipe(Effect.catchTag('ContentUnavailable', payloadUnavailable(runId)));
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
          .pipe(Effect.catchTag('ContentUnavailable', payloadUnavailable(runId)));
        const meta = yield* read('workflow_read_payload_meta', (db) =>
          db
            .select()
            .from(workflowPayloads)
            .where(eq(workflowPayloads.payloadRef, payloadRef))
            .get(),
        );
        return {
          payloadRef,
          mediaType: workflowPayloadMediaType,
          byteSize: meta?.byteSize ?? 0,
          value,
        };
      }),

    listEvidence: (runId, query) =>
      read('workflow_list_evidence', (db) => {
        requireRun(db, runId);
        const labels = parseLabelFilters(query.label ?? []);
        const subtree = booleanQuery(query.subtree) ?? false;
        // The cursor is bound to the normalized filters, so a continuation taken under one filter
        // set is refused against another rather than quietly serving a different listing.
        const filters = {
          frameId: query.frameId,
          executionId: query.executionId,
          subtree,
          role: query.role,
          labels: labels.map((label) => `${label.key}:${label.value}`),
        };
        // Plain keyset paging with no frozen boundary, unlike the recovery reads: evidence rows are
        // append-only and never mutate, so there is no torn view for a boundary to protect against.
        const binding: CursorBinding = {
          route: 'workflows.listEvidence',
          runId,
          filters,
          key: revisionKey,
        };
        const limit = limitOf(query.limit);
        const key = query.cursor === undefined ? null : decodeCursor(query.cursor, binding).key;
        const capture = aliasedTable(workflowOperations, 'capture_operation');
        const rows = db
          .select({
            evidence: workflowEvidence,
            operationKey: capture.operationKey,
            sourceOperationKey: sourceOperationKeyOf(),
          })
          .from(workflowEvidence)
          // Inner: a row cannot exist without its capture operation, which is what writes it.
          .innerJoin(capture, eq(capture.id, workflowEvidence.operationId))
          .where(
            and(
              eq(workflowEvidence.runId, runId),
              ...(query.frameId === undefined ? [] : [eq(workflowEvidence.frameId, query.frameId)]),
              ...(query.executionId === undefined
                ? []
                : subtree
                  ? [
                      sql`${workflowEvidence.executionId} IN ${subtreeExecutionIds(query.executionId)}`,
                    ]
                  : [eq(workflowEvidence.executionId, query.executionId)]),
              ...(query.role === undefined ? [] : [eq(workflowEvidence.role, query.role)]),
              ...labelPredicates(labels),
              ...(key === null ? [] : [gt(workflowEvidence.id, Number(key[0]))]),
            ),
          )
          .orderBy(asc(workflowEvidence.id))
          .limit(limit + 1)
          .all();
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        return {
          items: page.map((row) =>
            evidenceDto({
              ...row.evidence,
              operationKey: row.operationKey,
              sourceOperationKey: row.sourceOperationKey,
            }),
          ),
          nextCursor:
            rows.length > limit && last ? encodeCursor(binding, [last.evidence.id]) : null,
        };
      }),

    getEvidence: (runId, evidenceKey) =>
      read('workflow_get_evidence', (db) => {
        requireRun(db, runId);
        const row = evidenceRow(db, runId, evidenceKey);
        return {
          evidence: evidenceDto({
            ...row.evidence,
            operationKey: row.operationKey,
            sourceOperationKey: row.sourceOperationKey,
          }),
        };
      }),

    openEvidenceContent: (runId, evidenceKey) =>
      Effect.gen(function* () {
        const row = yield* read('workflow_open_evidence_content', (db) => {
          requireRun(db, runId);
          return evidenceRow(db, runId, evidenceKey).evidence;
        });
        const stream = yield* content
          .open(row.contentRef)
          .pipe(
            Effect.catchTag(
              'ContentUnavailable',
              evidenceContentUnavailable(runId, row.evidenceKey),
            ),
          );
        return {
          stream,
          mediaType: row.mediaType,
          byteSize: row.byteSize,
          filename: `${slug(row.title)}-${row.role}${extensionForMediaType(row.mediaType)}`,
        };
      }),

    listCheckpoints: (runId, query) =>
      read('workflow_list_checkpoints', (db) => {
        requireRun(db, runId);
        const descendants = booleanQuery(query.descendants) ?? false;
        // Bound to the normalized filters, as evidence is, so a continuation cannot quietly switch
        // listings. Rows are append-only and immutable, so no frozen boundary is needed.
        const binding: CursorBinding = {
          route: 'workflows.listCheckpoints',
          runId,
          filters: { executionId: query.executionId, descendants },
          key: revisionKey,
        };
        const limit = limitOf(query.limit);
        const key = query.cursor === undefined ? null : decodeCursor(query.cursor, binding).key;
        const rows = db
          .select()
          .from(workflowCheckpoints)
          .where(
            and(
              eq(workflowCheckpoints.runId, runId),
              ...(query.executionId === undefined
                ? []
                : descendants
                  ? [
                      sql`${workflowCheckpoints.executionId} IN ${subtreeExecutionIds(query.executionId)}`,
                    ]
                  : [eq(workflowCheckpoints.executionId, query.executionId)]),
              ...(key === null ? [] : [gt(workflowCheckpoints.id, Number(key[0]))]),
            ),
          )
          .orderBy(asc(workflowCheckpoints.id))
          .limit(limit + 1)
          .all()
          .map(checkpointRecord);
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        return {
          items: page.map(checkpointSummaryDto),
          nextCursor: rows.length > limit && last ? encodeCursor(binding, [last.id]) : null,
        };
      }),

    getCheckpoint: (runId, checkpointId) =>
      read('workflow_get_checkpoint', (db) => {
        requireRun(db, runId);
        return { checkpoint: checkpointDto(requireCheckpoint(db, runId, checkpointId)) };
      }),

    listCheckpointInventory: (runId, checkpointId, query) =>
      read('workflow_list_checkpoint_inventory', (db) => {
        requireRun(db, runId);
        const { checkpoint } = requireCheckpoint(db, runId, checkpointId);
        const binding: CursorBinding = {
          route: 'workflows.listCheckpointInventory',
          runId,
          filters: { checkpointId },
          key: revisionKey,
        };
        const limit = limitOf(query.limit);
        const key = query.cursor === undefined ? null : decodeCursor(query.cursor, binding).key;
        const rows = inventoryPage(db, {
          checkpointRowId: checkpoint.id,
          afterSeq: key === null ? null : Number(key[0]),
          take: limit + 1,
        });
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        return {
          checkpointId,
          entries: page.map((row) => row.entry),
          nextCursor: rows.length > limit && last ? encodeCursor(binding, [last.seq]) : null,
        };
      }),

    listCheckpointManifest: (runId, checkpointId, query) =>
      read('workflow_list_checkpoint_manifest', (db) => {
        requireRun(db, runId);
        const { checkpoint } = requireCheckpoint(db, runId, checkpointId);
        const binding: CursorBinding = {
          route: 'workflows.listCheckpointManifest',
          runId,
          filters: { checkpointId },
          key: layerEntryKey,
        };
        const limit = limitOf(query.limit);
        const key = query.cursor === undefined ? null : decodeCursor(query.cursor, binding).key;
        const items = manifestPage(db, {
          runId,
          selectedRowId: checkpoint.id,
          after: key === null ? null : [Number(key[0]), Number(key[1])],
          take: limit + 1,
        });
        const page = items.slice(0, limit);
        const last = page.at(-1);
        return {
          checkpointId,
          entries: page.map((item) => item.entry),
          nextCursor: items.length > limit && last ? encodeCursor(binding, [...last.key]) : null,
        };
      }),

    openCheckpointFileContent: (runId, checkpointId, fileId) =>
      Effect.gen(function* () {
        const file = yield* read('workflow_open_checkpoint_file_content', (db) => {
          requireRun(db, runId);
          const found = checkpointFileInRun(db, {
            runId,
            checkpointKey: checkpointId,
            fileKey: fileId,
          });
          if (found) return found;
          // Only on a miss: which of the two identities was wrong is the client's next step.
          requireCheckpoint(db, runId, checkpointId);
          throw new WorkflowEngineError({
            code: 'workflow_checkpoint_file_not_found',
            message: `Checkpoint ${checkpointId} has no saved file ${fileId}.`,
            workflowRunId: runId,
            checkpointId,
            fileId,
          });
        });
        const stream = yield* content
          .open(file.contentRef)
          .pipe(
            Effect.catchTag(
              'ContentUnavailable',
              checkpointContentUnavailable(runId, checkpointId, fileId),
            ),
          );
        return {
          stream,
          // The route never claims a type the capture did not record; clients choose presentation.
          mediaType: 'application/octet-stream',
          byteSize: file.byteSize,
          filename: posix.basename(file.path),
        };
      }),

    getOperation: (runId, operationKey) =>
      Effect.gen(function* () {
        // Projected through the revision snapshot store, exactly as `listOperations` is, so the two
        // routes can never describe the same operation differently. Reading the live columns here
        // would make this a second authority for one DTO shape.
        const dto = yield* read('workflow_get_operation', (db) => {
          const run = requireRun(db, runId);
          const row = db
            .select({ id: workflowOperations.id })
            .from(workflowOperations)
            .where(
              and(
                eq(workflowOperations.runId, runId),
                eq(workflowOperations.operationKey, operationKey),
              ),
            )
            .get();
          const projected =
            row === undefined
              ? undefined
              : recordsAt<WorkflowOperationDto>(db, {
                  runId,
                  kind: 'operation',
                  ids: [row.id],
                  atRevision: run.revision,
                }).get(row.id);
          if (!projected) {
            throw new WorkflowEngineError({
              code: 'workflow_operation_not_found',
              message: `Run ${runId} has no operation ${operationKey}.`,
              workflowRunId: runId,
              operationKey,
            });
          }
          return projected;
        });
        // Outside the database read on purpose: this is the one route allowed to stat a file, and
        // `operationDto` also runs inside write transactions, where IO must never happen.
        const { harness, harnessSessionId, cwd } = dto.provenance;
        const transcript =
          harness === null || harnessSessionId === null || cwd === null
            ? null
            : yield* locateTranscript({ harness, harnessSessionId, cwd });
        return { operation: { ...dto, provenance: { ...dto.provenance, transcript } } };
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

/**
 * One evidence row with both operation keys, scoped to its run.
 *
 * Run-scoped deliberately, exactly as the payload route is: a key another run recorded is not one
 * this run can serve, and the answer must not distinguish "never existed" from "belongs to somebody
 * else".
 */
/**
 * The source operation's public key, as a correlated lookup rather than a second join.
 *
 * A left join would be the natural expression, but combining one with the inner join above and a
 * whole-table selection collapses drizzle's row type to `never`. The lookup is a primary-key hit
 * per row and says the same thing: `null` when nothing resolved, which is a recorded answer rather
 * than a gap.
 */
function sourceOperationKeyOf() {
  return sql<
    string | null
  >`(SELECT op.operation_key FROM workflow_operations op WHERE op.id = ${workflowEvidence.sourceOperationId})`;
}

interface EvidenceRowWithKeys {
  readonly evidence: typeof workflowEvidence.$inferSelect;
  readonly operationKey: string;
  readonly sourceOperationKey: string | null;
}

function evidenceRow(
  db: RuntimeDrizzleDatabase,
  runId: number,
  evidenceKey: string,
): EvidenceRowWithKeys {
  const capture = aliasedTable(workflowOperations, 'capture_operation');
  const row = db
    .select({
      evidence: workflowEvidence,
      operationKey: capture.operationKey,
      sourceOperationKey: sourceOperationKeyOf(),
    })
    .from(workflowEvidence)
    .innerJoin(capture, eq(capture.id, workflowEvidence.operationId))
    .where(and(eq(workflowEvidence.runId, runId), eq(workflowEvidence.evidenceKey, evidenceKey)))
    .get();
  if (!row) {
    throw new WorkflowEngineError({
      code: 'workflow_evidence_not_found',
      message: `Run ${runId} has no captured evidence ${evidenceKey}.`,
      workflowRunId: runId,
      evidenceKey,
    });
  }
  return row;
}

function requireCheckpoint(db: RuntimeDrizzleDatabase, runId: number, checkpointId: string) {
  const found = checkpointInRun(db, runId, checkpointId);
  if (!found) {
    throw new WorkflowEngineError({
      code: 'workflow_checkpoint_not_found',
      message: `Run ${runId} has no saved checkpoint ${checkpointId}.`,
      workflowRunId: runId,
      checkpointId,
    });
  }
  return found;
}

function checkpointContentUnavailable(runId: number, checkpointId: string, fileId: string) {
  return (error: { readonly ref: string; readonly cause: 'missing' | 'corrupt' }) =>
    Effect.fail(
      new WorkflowEngineError({
        code: 'workflow_checkpoint_content_unavailable',
        message:
          error.cause === 'missing'
            ? `Saved file ${fileId} of ${checkpointId} is no longer stored.`
            : `Saved file ${fileId} of ${checkpointId} no longer matches its reference.`,
        workflowRunId: runId,
        checkpointId,
        fileId,
        payloadCause: error.cause,
      }),
    );
}

function evidenceContentUnavailable(runId: number, evidenceKey: string) {
  return (error: { readonly ref: string; readonly cause: 'missing' | 'corrupt' }) =>
    Effect.fail(
      new WorkflowEngineError({
        code: 'workflow_evidence_content_unavailable',
        message:
          error.cause === 'missing'
            ? `Captured content for ${evidenceKey} is no longer stored.`
            : `Captured content for ${evidenceKey} no longer matches its reference.`,
        workflowRunId: runId,
        evidenceKey,
        payloadCause: error.cause,
      }),
    );
}

/**
 * The title, reduced to something safe to put in a filename.
 *
 * ASCII lowercase, digits and single hyphens only, capped at 64 characters, so the result needs no
 * RFC 5987 encoding and carries nothing that could break out of a header. A title with nothing
 * usable in it becomes `evidence` rather than an empty name.
 */
function slug(title: string): string {
  const reduced = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return reduced.length > 0 ? reduced : 'evidence';
}
