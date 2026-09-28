import { Effect, type ManagedRuntime } from 'effect';
import type { FastifyInstance } from 'fastify';

import {
  apiEndpoints,
  workflowContentEndpoints,
  type ApiError,
  type WorkflowRejectionData,
} from '@isagi/contracts';

import {
  errorMessage,
  infrastructureApiError,
  registerApiEndpoint,
  registerContentEndpoint,
  type ApiRouteContext,
} from '../lib/api/index.js';
import type { RuntimeServices } from '../runtime.layer.js';
import { WorkflowEngine } from './engine/service.js';
import { WorkflowEngineError } from './errors.js';

/**
 * The workflow HTTP surface: launch, the controls, and plain reads.
 *
 * Every control returns the run's summary after it was applied. Live changes reach clients on the
 * shared runtime event socket as `workflow_run_event` and `workflow_run_changed`; these routes are
 * what a client refetches from.
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

  register(endpoints.descriptors, (input) =>
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const listings = yield* engine.listWorkflowDescriptors(input.origin);
      return {
        workflows: listings.map((listing) =>
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
    Effect.flatMap(WorkflowEngine, (engine) =>
      engine.launch({
        workflowKey: input.workflowKey,
        inputs: input.inputs ?? {},
        origin: input.origin,
        ...(input.placement === undefined ? {} : { placement: input.placement }),
      }),
    ),
  );

  register(endpoints.listRuns, (_input, _context, _params, query) =>
    Effect.flatMap(WorkflowEngine, (engine) => engine.listRuns(query)),
  );
  register(endpoints.getRun, (_input, _context, params) =>
    Effect.flatMap(WorkflowEngine, (engine) => engine.getRun(params.runId)),
  );
  register(endpoints.getStructure, (_input, _context, params, query) =>
    Effect.flatMap(WorkflowEngine, (engine) =>
      engine.getStructure(params.runId, query.artifactHash),
    ),
  );
  register(endpoints.listEvents, (_input, _context, params, query) =>
    Effect.flatMap(WorkflowEngine, (engine) => engine.listEvents(params.runId, query)),
  );
  register(endpoints.listOperations, (_input, _context, params, query) =>
    Effect.flatMap(WorkflowEngine, (engine) => engine.listOperations(params.runId, query)),
  );
  register(endpoints.getExecution, (_input, _context, params) =>
    Effect.flatMap(WorkflowEngine, (engine) => engine.getExecution(params.executionId)),
  );
  register(endpoints.getOperation, (_input, _context, params) =>
    Effect.flatMap(WorkflowEngine, (engine) => engine.getOperation(params.operationId)),
  );

  register(endpoints.listCheckpoints, (_input, _context, params, query) =>
    Effect.flatMap(WorkflowEngine, (engine) => engine.listCheckpoints(params.runId, query)),
  );
  register(endpoints.getCheckpoint, (_input, _context, params) =>
    Effect.flatMap(WorkflowEngine, (engine) => engine.getCheckpoint(params.checkpointId)),
  );
  register(endpoints.exportCheckpoint, (input, _context, params) =>
    Effect.flatMap(WorkflowEngine, (engine) =>
      engine.exportCheckpoint(params.checkpointId, input.destinationPath),
    ),
  );
  registerContentEndpoint<typeof workflowContentEndpoints.getCheckpointFile, RuntimeServices>(
    fastify,
    workflowContentEndpoints.getCheckpointFile,
    {
      handle: (_context, params, query) =>
        Effect.flatMap(WorkflowEngine, (engine) =>
          engine.openCheckpointFile(params.checkpointId, query.path),
        ),
      mapError: toWorkflowApiError,
      run,
    },
  );

  register(endpoints.pause, (_input, _context, params) =>
    Effect.map(
      Effect.flatMap(WorkflowEngine, (engine) => engine.pause(params.runId)),
      (summary) => ({ run: summary }),
    ),
  );
  register(endpoints.resume, (_input, _context, params) =>
    Effect.map(
      Effect.flatMap(WorkflowEngine, (engine) => engine.resume(params.runId)),
      (summary) => ({ run: summary }),
    ),
  );
  register(endpoints.retry, (_input, _context, params) =>
    Effect.map(
      Effect.flatMap(WorkflowEngine, (engine) => engine.retry(params.runId)),
      (summary) => ({ run: summary }),
    ),
  );
  register(endpoints.cancel, (_input, _context, params) =>
    Effect.map(
      Effect.flatMap(WorkflowEngine, (engine) => engine.cancel(params.runId)),
      (summary) => ({ run: summary }),
    ),
  );
  register(endpoints.dismiss, (_input, _context, params) =>
    Effect.map(
      Effect.flatMap(WorkflowEngine, (engine) => engine.dismiss(params.runId)),
      (summary) => ({ run: summary }),
    ),
  );
  register(endpoints.advance, (input, _context, params) =>
    Effect.map(
      Effect.flatMap(WorkflowEngine, (engine) =>
        engine.advance({
          runId: params.runId,
          executionId: input.executionId,
          answers: input.answers,
        }),
      ),
      (summary) => ({ run: summary }),
    ),
  );
}

/** One vocabulary: the engine already decides in the contract's reasons, so this only copies context. */
function toWorkflowApiError(error: unknown, context: ApiRouteContext): ApiError {
  if (error instanceof WorkflowEngineError) {
    const identities = {
      ...(error.workflowKey ? { workflowKey: error.workflowKey } : {}),
      ...(error.workflowRunId ? { workflowRunId: error.workflowRunId } : {}),
      ...(error.activeWorkflowRunId ? { activeWorkflowRunId: error.activeWorkflowRunId } : {}),
      ...(error.worktreeId ? { worktreeId: error.worktreeId } : {}),
      ...(error.surfaceId ? { surfaceId: error.surfaceId } : {}),
      ...(error.paneId ? { paneId: error.paneId } : {}),
      ...(error.agentSessionId ? { agentSessionId: error.agentSessionId } : {}),
      ...(error.executionId ? { executionId: error.executionId } : {}),
      ...(error.operationId ? { operationId: error.operationId } : {}),
      ...(error.checkpointId ? { checkpointId: error.checkpointId } : {}),
      ...(error.path ? { path: error.path } : {}),
      ...(error.commitSha ? { commitSha: error.commitSha } : {}),
      ...(error.control ? { control: error.control } : {}),
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
      ...(error.placementIssue ? { placementIssue: error.placementIssue } : {}),
      ...(error.collision ? { collision: error.collision } : {}),
      ...(error.branch ? { branch: error.branch } : {}),
      ...(error.baseRef ? { baseRef: error.baseRef } : {}),
      ...(error.projectId ? { projectId: error.projectId } : {}),
    };
    return {
      code: 'workflow_rejected',
      status: statusFor(error.code),
      message: error.message,
      requestId: context.requestId,
      data: rejectionData(error, identities),
    };
  }

  // Launch makes one owning-service call (the worktree preflight), so Git, the database, the
  // state file and project paths can fail underneath it. They are reported as themselves.
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

function rejectionData(
  error: WorkflowEngineError,
  identities: Record<string, unknown>,
): WorkflowRejectionData {
  switch (error.code) {
    case 'workflow_structure_validation_failed':
    case 'workflow_code_incompatible':
      return { ...identities, reason: error.code, diagnostics: [...(error.diagnostics ?? [])] };
    case 'workflow_checkpoint_destination_rejected':
      return {
        ...identities,
        reason: error.code,
        destinationPath: error.destination?.path ?? '',
        destinationIssue: error.destination?.issue ?? 'inaccessible',
      };
    default:
      return { ...identities, reason: error.code };
  }
}

function statusFor(code: WorkflowEngineError['code']): 400 | 409 | 500 {
  switch (code) {
    case 'workflow_discovery_failed':
    case 'workflow_checkpoint_export_failed':
      return 500;
    // A conflict with somebody else's state: the request would succeed against a different one.
    case 'workflow_surface_busy':
    case 'workflow_environment_collision':
    case 'workflow_control_unavailable':
    case 'workflow_code_incompatible':
    case 'workflow_checkpoint_commit_unavailable':
      return 409;
    default:
      return 400;
  }
}
