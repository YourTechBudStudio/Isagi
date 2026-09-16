import { Effect, type ManagedRuntime } from 'effect';
import type { FastifyInstance } from 'fastify';

import { apiEndpoints, type ApiError } from '@isagi/contracts';

import { registerApiEndpoint, type ApiRouteContext, errorMessage } from '../lib/api/index.js';
import { DatabaseError } from '../persistence/index.js';
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
            : { reason: error.code, ...identities },
    };
  }

  if (error instanceof DatabaseError) {
    return {
      code: 'runtime_database_failed',
      status: 500,
      message: `Database operation failed: ${error.operation}`,
      requestId: context.requestId,
      data: { operation: error.operation },
    };
  }

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
  return 400;
}
