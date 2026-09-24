import { Effect, type ManagedRuntime } from 'effect';
import type { FastifyInstance } from 'fastify';

import { apiEndpoints, workflowContentEndpoints, type ApiError } from '@isagi/contracts';

import {
  infrastructureApiError,
  registerApiEndpoint,
  registerContentEndpoint,
  type ApiRouteContext,
  errorMessage,
} from '../lib/api/index.js';
import type { RuntimeServices } from '../runtime.layer.js';
import { WorkflowEngine } from './engine/interpreter.service.js';
import { WorkflowRunProjection } from './read/projection.service.js';
import { WorkflowEngineError } from './types.js';

/**
 * The workflow HTTP surface: one retained read model, six controls, and a launch path.
 *
 * Reads and mutations are deliberately different shapes. A read answers from durable records and
 * changes nothing — no reconciliation, no repair, no old code imported, no prompt delivered. A
 * mutation returns only what was accepted and where the run is now; the read routes and the
 * committed revision deltas are the authority for everything else, so a control result can never
 * become a second, competing snapshot.
 *
 * There is no per-run websocket. Committed transitions reach clients on the shared runtime event
 * bus, and a client that misses one recovers the identical deltas through the paginated history
 * routes.
 */

const runWithRuntime =
  (runtime: ManagedRuntime.ManagedRuntime<RuntimeServices, unknown>) =>
  <A>(
    effect: Effect.Effect<A, unknown, RuntimeServices>,
    options?: { readonly signal?: AbortSignal | undefined },
  ) =>
    runtime.runPromise(effect, options);

export function registerWorkflowApi(
  fastify: FastifyInstance,
  runtime: ManagedRuntime.ManagedRuntime<RuntimeServices, unknown>,
) {
  const run = runWithRuntime(runtime);
  const endpoints = apiEndpoints.workflows;
  const register = <Endpoint extends Parameters<typeof registerApiEndpoint>[1]>(
    endpoint: Endpoint,
    handle: Parameters<typeof registerApiEndpoint<Endpoint, RuntimeServices>>[2]['handle'],
  ) =>
    registerApiEndpoint<Endpoint, RuntimeServices>(fastify, endpoint, {
      handle,
      mapError: toWorkflowApiError,
      run,
    });

  // --- launch ---------------------------------------------------------------

  register(endpoints.descriptors, (input) =>
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const workflows = yield* engine.listWorkflowDescriptors({ origin: input.origin });
      return {
        workflows: workflows.map((listing) =>
          listing.result.ok
            ? {
                ok: true as const,
                workflowKey: listing.workflowKey,
                manifest: listing.result.manifest,
              }
            : {
                ok: false as const,
                workflowKey: listing.workflowKey,
                reason: listing.result.reason,
                diagnostics: [...listing.result.diagnostics],
              },
        ),
      };
    }),
  );

  register(endpoints.start, (input) =>
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const created = yield* engine.startWorkflow({
        workflowKey: input.workflowKey,
        inputs: input.inputs,
        origin: input.origin,
        // Omitted rather than passed as undefined: absent means "no override, select normally",
        // and the engine's own selection reads the key's presence.
        ...(input.placement === undefined ? {} : { placement: input.placement }),
      });
      return { runId: created.id, workflowKey: created.workflowKey };
    }),
  );

  // --- retained reads -------------------------------------------------------

  register(endpoints.listRuns, (_input, _context, _params, query) =>
    Effect.flatMap(WorkflowRunProjection, (projection) => projection.listRuns(query)),
  );

  register(endpoints.getRun, (_input, _context, params) =>
    Effect.flatMap(WorkflowRunProjection, (projection) => projection.getRun(params.runId)),
  );

  register(endpoints.getStructure, (_input, _context, params, query) =>
    Effect.flatMap(WorkflowRunProjection, (projection) =>
      projection.getStructure(params.runId, query),
    ),
  );

  register(endpoints.listVersions, (_input, _context, params, query) =>
    Effect.flatMap(WorkflowRunProjection, (projection) =>
      projection.listVersions(params.runId, query),
    ),
  );

  register(endpoints.listFrames, (_input, _context, params, query) =>
    Effect.flatMap(WorkflowRunProjection, (projection) =>
      projection.listFrames(params.runId, query),
    ),
  );

  register(endpoints.listFrameExecutions, (_input, _context, params, query) =>
    Effect.flatMap(WorkflowRunProjection, (projection) =>
      projection.listFrameExecutions(params.runId, params.frameId, query),
    ),
  );

  register(endpoints.listExecutions, (_input, _context, params, query) =>
    Effect.flatMap(WorkflowRunProjection, (projection) =>
      projection.listRunExecutions(params.runId, query),
    ),
  );

  register(endpoints.listAttempts, (_input, _context, params, query) =>
    Effect.flatMap(WorkflowRunProjection, (projection) =>
      projection.listAttempts(params.runId, query),
    ),
  );

  register(endpoints.getAttempt, (_input, _context, params) =>
    Effect.flatMap(WorkflowRunProjection, (projection) =>
      projection.getAttempt(params.runId, params.attemptId),
    ),
  );

  register(endpoints.listOperations, (_input, _context, params, query) =>
    Effect.flatMap(WorkflowRunProjection, (projection) =>
      projection.listOperations(params.runId, query),
    ),
  );

  register(endpoints.listEvents, (_input, _context, params, query) =>
    Effect.flatMap(WorkflowRunProjection, (projection) =>
      projection.listEvents(params.runId, query),
    ),
  );

  register(endpoints.getPayload, (_input, _context, params) =>
    Effect.flatMap(WorkflowRunProjection, (projection) =>
      projection.getPayload(params.runId, params.payloadRef),
    ),
  );

  // --- evidence -------------------------------------------------------------

  register(endpoints.getOperation, (_input, _context, params) =>
    Effect.flatMap(WorkflowRunProjection, (projection) =>
      projection.getOperation(params.runId, params.operationKey),
    ),
  );

  register(endpoints.listEvidence, (_input, _context, params, query) =>
    Effect.flatMap(WorkflowRunProjection, (projection) =>
      projection.listEvidence(params.runId, query),
    ),
  );

  register(endpoints.getEvidence, (_input, _context, params) =>
    Effect.flatMap(WorkflowRunProjection, (projection) =>
      projection.getEvidence(params.runId, params.evidenceKey),
    ),
  );

  /**
   * The one route in the runtime whose success body is not the JSON envelope.
   *
   * It is a declared content endpoint rather than a hand-rolled raw route, so its params, query and
   * error contract are checked exactly like every other route's, and every non-200 it can send is
   * still the envelope a client already knows how to read.
   */
  registerContentEndpoint<typeof workflowContentEndpoints.getEvidenceContent, RuntimeServices>(
    fastify,
    workflowContentEndpoints.getEvidenceContent,
    {
      handle: (_context, params) =>
        Effect.flatMap(WorkflowRunProjection, (projection) =>
          projection.openEvidenceContent(params.runId, params.evidenceKey),
        ),
      attachment: (query) => query?.download === 'true',
      mapError: toWorkflowApiError,
      run,
    },
  );

  // --- checkpoints ----------------------------------------------------------

  register(endpoints.listCheckpoints, (_input, _context, params, query) =>
    Effect.flatMap(WorkflowRunProjection, (projection) =>
      projection.listCheckpoints(params.runId, query),
    ),
  );

  register(endpoints.getCheckpoint, (_input, _context, params) =>
    Effect.flatMap(WorkflowRunProjection, (projection) =>
      projection.getCheckpoint(params.runId, params.checkpointId),
    ),
  );

  register(endpoints.listCheckpointInventory, (_input, _context, params, query) =>
    Effect.flatMap(WorkflowRunProjection, (projection) =>
      projection.listCheckpointInventory(params.runId, params.checkpointId, query),
    ),
  );

  register(endpoints.listCheckpointManifest, (_input, _context, params, query) =>
    Effect.flatMap(WorkflowRunProjection, (projection) =>
      projection.listCheckpointManifest(params.runId, params.checkpointId, query),
    ),
  );

  registerContentEndpoint<
    typeof workflowContentEndpoints.getCheckpointFileContent,
    RuntimeServices
  >(fastify, workflowContentEndpoints.getCheckpointFileContent, {
    handle: (_context, params) =>
      Effect.flatMap(WorkflowRunProjection, (projection) =>
        projection.openCheckpointFileContent(params.runId, params.checkpointId, params.fileId),
      ),
    attachment: (query) => query?.download === 'true',
    mapError: toWorkflowApiError,
    run,
  });

  // --- controls -------------------------------------------------------------

  register(endpoints.pause, (_input, _context, params) =>
    Effect.flatMap(WorkflowEngine, (engine) => engine.pause({ runId: params.runId })),
  );

  register(endpoints.resume, (_input, _context, params) =>
    Effect.flatMap(WorkflowEngine, (engine) => engine.resume({ runId: params.runId })),
  );

  register(endpoints.retry, (_input, _context, params) =>
    Effect.flatMap(WorkflowEngine, (engine) => engine.retry({ runId: params.runId })),
  );

  register(endpoints.cancel, (_input, _context, params) =>
    Effect.flatMap(WorkflowEngine, (engine) => engine.cancel({ runId: params.runId })),
  );

  register(endpoints.dismiss, (_input, _context, params) =>
    Effect.flatMap(WorkflowEngine, (engine) => engine.dismiss({ runId: params.runId })),
  );

  register(endpoints.advance, (input, _context, params) =>
    Effect.flatMap(WorkflowEngine, (engine) =>
      engine.advance({ runId: params.runId, waitId: input.waitId, answers: input.answers }),
    ),
  );
}

/**
 * One vocabulary, mapped rather than renamed.
 *
 * The engine already decides in the contract's own reason set, so this maps identities and context
 * onto the wire envelope and never invents a reason. The two reasons whose context is mandatory
 * carry it here, because a client that must render a structural rejection or an unreadable payload
 * cannot do so from a reason alone.
 */
function toWorkflowApiError(error: unknown, context: ApiRouteContext): ApiError {
  if (error instanceof WorkflowEngineError) {
    const identities = {
      ...(error.workflowKey ? { workflowKey: error.workflowKey } : {}),
      ...(error.workflowRunId ? { workflowRunId: error.workflowRunId } : {}),
      ...(error.activeWorkflowRunId ? { activeWorkflowRunId: error.activeWorkflowRunId } : {}),
      ...(error.operation ? { operation: error.operation } : {}),
      ...(error.worktreeId ? { worktreeId: error.worktreeId } : {}),
      ...(error.surfaceId ? { surfaceId: error.surfaceId } : {}),
      ...(error.paneId ? { paneId: error.paneId } : {}),
      ...(error.agentSessionId ? { agentSessionId: error.agentSessionId } : {}),
      ...(error.workflowLoadFailureReason
        ? { workflowLoadFailureReason: error.workflowLoadFailureReason }
        : {}),
      ...(error.workflowSourceDirectory
        ? { workflowSourceDirectory: error.workflowSourceDirectory }
        : {}),
      ...(error.workflowPackageDirectory
        ? { workflowPackageDirectory: error.workflowPackageDirectory }
        : {}),
      ...(error.shadowedWorkflowPackageDirectories?.length
        ? { shadowedWorkflowPackageDirectories: [...error.shadowedWorkflowPackageDirectories] }
        : {}),
      ...(error.artifactHash ? { artifactHash: error.artifactHash } : {}),
      ...(error.operationKey ? { operationKey: error.operationKey } : {}),
      ...(error.evidenceKey ? { evidenceKey: error.evidenceKey } : {}),
      ...(error.checkpointId ? { checkpointId: error.checkpointId } : {}),
      ...(error.fileId ? { fileId: error.fileId } : {}),
      ...(error.placementIssue ? { placementIssue: error.placementIssue } : {}),
      ...(error.collision ? { collision: error.collision } : {}),
      ...(error.branch ? { branch: error.branch } : {}),
      ...(error.baseRef ? { baseRef: error.baseRef } : {}),
      ...(error.projectId ? { projectId: error.projectId } : {}),
    };

    return {
      code: 'workflow_rejected',
      status: statusForWorkflowRejection(error.code),
      message: error.message,
      requestId: context.requestId,
      data:
        error.code === 'workflow_structure_validation_failed'
          ? { reason: error.code, diagnostics: [...(error.diagnostics ?? [])], ...identities }
          : error.code === 'workflow_payload_unavailable'
            ? {
                reason: error.code,
                payloadRef: error.payloadRef ?? '',
                cause: error.payloadCause ?? 'missing',
                ...identities,
              }
            : error.code === 'workflow_evidence_content_unavailable'
              ? {
                  reason: error.code,
                  evidenceKey: error.evidenceKey ?? '',
                  cause: error.payloadCause ?? 'missing',
                  ...identities,
                }
              : error.code === 'workflow_checkpoint_content_unavailable'
                ? {
                    reason: error.code,
                    checkpointId: error.checkpointId ?? '',
                    fileId: error.fileId ?? '',
                    cause: error.payloadCause ?? 'missing',
                    ...identities,
                  }
                : { reason: error.code, ...identities },
    };
  }

  /**
   * The launch path's one owning-service call, and what it can fail with that is not a placement.
   *
   * `resolvePlacement` maps every `WorkspaceError` the worktree preflight raises into a workflow
   * rejection, so what reaches here is infrastructure: Git, the database, the state file, project
   * paths, project configuration. It is reported through the shared mapper rather than restated
   * here, so the same Git failure reads identically whichever route hit it.
   *
   * One class the launch channel declares is deliberately not covered there: `WorktreeSetupRunError`
   * is in `WorkspaceServiceError` because `openWorktree` and `runWorktreeSetup` can raise it,
   * neither of which the launch path calls — the preflight runs no hooks. It also has no honest
   * `worktree_setup_rejected` reason, since that union names configuration and trust states rather
   * than a hook that failed while running, and inventing one would put a wrong fact on the response.
   * It therefore falls through to the unhandled arm below and is logged. Preparation, which *can*
   * really produce it, records it as a segment failure and never as a fault.
   */
  const infrastructure = infrastructureApiError(error, context);
  if (infrastructure) return infrastructure;

  console.error(
    `[runtime] Unhandled workflow API handler error during ${context.endpointId}`,
    error,
  );

  return {
    code: 'api_unhandled_error',
    status: 500,
    message: errorMessage(error),
    requestId: context.requestId,
    data: { endpointId: context.endpointId },
  };
}

function statusForWorkflowRejection(code: WorkflowEngineError['code']): 400 | 409 | 500 {
  if (code === 'workflow_discovery_failed') return 500;
  // A surface already showing a run is a conflict with somebody else's state, not a bad request.
  if (code === 'workflow_surface_attached') return 409;
  // So is a branch, worktree or checkout path that already exists: the request is well-formed and
  // would succeed against a different live state. The workspace boundary answers 409 for the same
  // underlying condition on `worktrees.open`.
  if (code === 'workflow_environment_collision') return 409;
  return 400;
}
