import { Effect, type Layer } from 'effect';
import type { FastifyInstance } from 'fastify';

import {
  apiEndpoints,
  workflowContentEndpoints,
  type WorkflowRejectionData,
} from '@isagi/contracts';

import {
  registerApiEndpoint,
  registerContentEndpoint,
  type ApiRejected,
  type Rejection,
  type RouteRuntime,
} from '../platform/http/index.js';
import { workspaceRejections } from '../workspace/index.js';
import type { PlacementInfrastructureError } from './engine/environment/placement.js';
import { WorkflowEngine } from './engine/service.js';
import type { WorkflowEngineError } from './errors.js';
import type { WorkflowsLayer } from './layer.js';

/**
 * The workflow HTTP surface: launch, the controls, and plain reads.
 *
 * Every control returns the run's summary after it was applied. Live changes reach clients on the
 * shared runtime event socket as `workflow_run_event` and `workflow_run_changed`; these routes are
 * what a client refetches from.
 *
 * Every endpoint maps `WorkflowEngineError` with `rejectWorkflow`: the engine already decides in
 * the contract's reasons, so mapping only copies context. Database and Git failures pass through
 * as infrastructure errors, which every workflow endpoint declares.
 */

/** Every workflow endpoint declares the same error union, so one rejection type serves them all. */
type WorkflowRejection = Rejection<typeof apiEndpoints.workflows.start>;

export function registerWorkflowsRoutes(
  fastify: FastifyInstance,
  runtime: RouteRuntime<Layer.Success<typeof WorkflowsLayer>>,
) {
  const endpoints = apiEndpoints.workflows;

  registerApiEndpoint(fastify, runtime, endpoints.descriptors, (request) =>
    WorkflowEngine.use((engine) => engine.listWorkflowDescriptors(request.body.origin)).pipe(
      Effect.map((listings) => ({
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
      })),
      Effect.catchTag('WorkflowEngineError', rejectWorkflow(request)),
    ),
  );

  registerApiEndpoint(fastify, runtime, endpoints.start, (request) =>
    WorkflowEngine.use((engine) =>
      engine.launch({
        workflowKey: request.body.workflowKey,
        inputs: request.body.inputs ?? {},
        origin: request.body.origin,
        ...(request.body.placement === undefined ? {} : { placement: request.body.placement }),
      }),
    ).pipe(Effect.catchTags(launchRejections(request))),
  );

  registerApiEndpoint(fastify, runtime, endpoints.listRuns, (request) =>
    WorkflowEngine.use((engine) => engine.listRuns(request.query)),
  );
  registerApiEndpoint(fastify, runtime, endpoints.getRun, (request) =>
    WorkflowEngine.use((engine) => engine.getRun(request.params.runId)).pipe(
      Effect.catchTag('WorkflowEngineError', rejectWorkflow(request)),
    ),
  );
  registerApiEndpoint(fastify, runtime, endpoints.getStructure, (request) =>
    WorkflowEngine.use((engine) =>
      engine.getStructure(request.params.runId, request.query.artifactHash),
    ).pipe(Effect.catchTag('WorkflowEngineError', rejectWorkflow(request))),
  );
  registerApiEndpoint(fastify, runtime, endpoints.listEvents, (request) =>
    WorkflowEngine.use((engine) => engine.listEvents(request.params.runId, request.query)).pipe(
      Effect.catchTag('WorkflowEngineError', rejectWorkflow(request)),
    ),
  );
  registerApiEndpoint(fastify, runtime, endpoints.listOperations, (request) =>
    WorkflowEngine.use((engine) => engine.listOperations(request.params.runId, request.query)).pipe(
      Effect.catchTag('WorkflowEngineError', rejectWorkflow(request)),
    ),
  );
  registerApiEndpoint(fastify, runtime, endpoints.getExecution, (request) =>
    WorkflowEngine.use((engine) => engine.getExecution(request.params.executionId)).pipe(
      Effect.catchTag('WorkflowEngineError', rejectWorkflow(request)),
    ),
  );
  registerApiEndpoint(fastify, runtime, endpoints.getOperation, (request) =>
    WorkflowEngine.use((engine) => engine.getOperation(request.params.operationId)).pipe(
      Effect.catchTag('WorkflowEngineError', rejectWorkflow(request)),
    ),
  );

  registerApiEndpoint(fastify, runtime, endpoints.listCheckpoints, (request) =>
    WorkflowEngine.use((engine) =>
      engine.listCheckpoints(request.params.runId, request.query),
    ).pipe(Effect.catchTag('WorkflowEngineError', rejectWorkflow(request))),
  );
  registerApiEndpoint(fastify, runtime, endpoints.getCheckpoint, (request) =>
    WorkflowEngine.use((engine) => engine.getCheckpoint(request.params.checkpointId)).pipe(
      Effect.catchTag('WorkflowEngineError', rejectWorkflow(request)),
    ),
  );
  registerApiEndpoint(fastify, runtime, endpoints.exportCheckpoint, (request) =>
    WorkflowEngine.use((engine) =>
      engine.exportCheckpoint(request.params.checkpointId, request.body.destinationPath),
    ).pipe(Effect.catchTag('WorkflowEngineError', rejectWorkflow(request))),
  );
  registerContentEndpoint(fastify, runtime, workflowContentEndpoints.getCheckpointFile, (request) =>
    WorkflowEngine.use((engine) =>
      engine.openCheckpointFile(request.params.checkpointId, request.query.path),
    ).pipe(Effect.catchTag('WorkflowEngineError', rejectWorkflow(request))),
  );

  registerApiEndpoint(fastify, runtime, endpoints.pause, (request) =>
    WorkflowEngine.use((engine) => engine.pause(request.params.runId)).pipe(
      Effect.map((run) => ({ run })),
      Effect.catchTag('WorkflowEngineError', rejectWorkflow(request)),
    ),
  );
  registerApiEndpoint(fastify, runtime, endpoints.resume, (request) =>
    WorkflowEngine.use((engine) => engine.resume(request.params.runId)).pipe(
      Effect.map((run) => ({ run })),
      Effect.catchTag('WorkflowEngineError', rejectWorkflow(request)),
    ),
  );
  registerApiEndpoint(fastify, runtime, endpoints.retry, (request) =>
    WorkflowEngine.use((engine) => engine.retry(request.params.runId)).pipe(
      Effect.map((run) => ({ run })),
      Effect.catchTag('WorkflowEngineError', rejectWorkflow(request)),
    ),
  );
  registerApiEndpoint(fastify, runtime, endpoints.cancel, (request) =>
    WorkflowEngine.use((engine) => engine.cancel(request.params.runId)).pipe(
      Effect.map((run) => ({ run })),
      Effect.catchTag('WorkflowEngineError', rejectWorkflow(request)),
    ),
  );
  registerApiEndpoint(fastify, runtime, endpoints.dismiss, (request) =>
    WorkflowEngine.use((engine) => engine.dismiss(request.params.runId)).pipe(
      Effect.map((run) => ({ run })),
      Effect.catchTag('WorkflowEngineError', rejectWorkflow(request)),
    ),
  );
  registerApiEndpoint(fastify, runtime, endpoints.advance, (request) =>
    WorkflowEngine.use((engine) =>
      engine.advance({
        runId: request.params.runId,
        executionId: request.body.executionId,
        answers: request.body.answers,
      }),
    ).pipe(
      Effect.map((run) => ({ run })),
      Effect.catchTag('WorkflowEngineError', rejectWorkflow(request)),
    ),
  );
}

/**
 * What a workflow route needs of its request to refuse it. Every workflow endpoint declares the same
 * error union, so each endpoint's typed `reject` accepts exactly a `WorkflowRejection`.
 */
interface WorkflowRequest {
  readonly reject: (
    rejection: WorkflowRejection,
  ) => Effect.Effect<never, ApiRejected<WorkflowRejection>>;
}

/** Rejects with the workflow's own vocabulary. */
function rejectWorkflow(request: WorkflowRequest) {
  return (error: WorkflowEngineError) => request.reject(workflowRejection(error));
}

/**
 * Launch makes one owning-service call — the worktree preflight — so the workspace's own
 * endpoint-independent failures can surface beneath it, each read the way every workspace route
 * reports it. Each workspace builder is typed as the exact contract error it builds, and the
 * workflow error union declares all three, so no cast is needed.
 */
function launchRejections(request: WorkflowRequest) {
  return {
    WorkflowEngineError: rejectWorkflow(request),
    ProjectConfigError: (
      error: Extract<PlacementInfrastructureError, { _tag: 'ProjectConfigError' }>,
    ) => request.reject(workspaceRejections.projectConfig(error)),
    WorktreeSetupError: (
      error: Extract<PlacementInfrastructureError, { _tag: 'WorktreeSetupError' }>,
    ) => request.reject(workspaceRejections.worktreeSetup(error)),
    StateFileError: (error: Extract<PlacementInfrastructureError, { _tag: 'StateFileError' }>) =>
      request.reject(workspaceRejections.stateFile(error)),
  } as const;
}

/** One vocabulary: the engine already decides in the contract's reasons, so this only copies context. */
function workflowRejection(error: WorkflowEngineError): WorkflowRejection {
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
    data: rejectionData(error, identities),
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
