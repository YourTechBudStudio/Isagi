import type {
  ApiError,
  runtimeStateFileFailedErrorSchema,
  WorktreeSetupRejectedError,
  WorktreeSetupRejectionReason,
} from '@isagi/contracts';

import { ProjectConfigError } from '../projects/index.js';
import { WorktreeSetupError } from './setup/service.js';
import { StateFileError } from './state-file.js';

/** An API error payload before the boundary stamps the request id onto it. */
export type WorkspaceRejection = Omit<ApiError, 'requestId'>;

type WorktreeSetupRejection = Omit<WorktreeSetupRejectedError, 'requestId'>;
type StateFileRejection = Omit<typeof runtimeStateFileFailedErrorSchema.Type, 'requestId'>;

/**
 * How the workspace's endpoint-independent failures reach a client.
 *
 * Project configuration, worktree setup and the state file can fail underneath any workspace or
 * workflow endpoint that touches a project, so each one reads the same whichever route hit it.
 * These are pure builders: each returns today's exact wire payload, minus the request id the
 * boundary owns. Each is typed as the exact contract error it builds, so a typed endpoint's
 * `request.reject` accepts it only where the contract declares that code. `worktrees.open` keeps its
 * own `worktree_open_rejected` mapping for the two setup failures.
 */
export const workspaceRejections = {
  projectConfig: (error: ProjectConfigError): WorktreeSetupRejection => ({
    code: 'worktree_setup_rejected',
    status: 400,
    message: error.message,
    data: {
      reason: 'setup_config_invalid',
      ...(error.projectId ? { projectId: error.projectId } : {}),
    },
  }),
  worktreeSetup: (error: WorktreeSetupError): WorktreeSetupRejection => ({
    code: 'worktree_setup_rejected',
    status: 400,
    message: error.message,
    data: {
      reason: setupRejectionReason(error),
      ...(error.projectId ? { projectId: error.projectId } : {}),
      ...(error.hash ? { hash: error.hash } : {}),
    },
  }),
  stateFile: (error: StateFileError): StateFileRejection => ({
    code: 'runtime_state_file_failed',
    status: 500,
    message: `State file operation failed: ${error.operation}`,
    data: { operation: error.operation },
  }),
} as const;

/**
 * The workspace rejection for `error`, or `null` when it is not one of the three workspace
 * failures. Returning `null` leaves each boundary to decide what an unrecognised error means there,
 * exactly like the platform's `infrastructureApiError`.
 */
function workspaceRejectionFor(error: unknown): WorkspaceRejection | null {
  if (error instanceof ProjectConfigError) return workspaceRejections.projectConfig(error);
  if (error instanceof WorktreeSetupError) return workspaceRejections.worktreeSetup(error);
  if (error instanceof StateFileError) return workspaceRejections.stateFile(error);
  return null;
}

/**
 * TRANSITIONAL (plan R20): `workspaceRejectionFor` stamped with the request id, for the untyped
 * `mapError` of routes still on `registerLegacyApiEndpoint` (today: the workflow routes). Typed
 * endpoints use `workspaceRejections` in their `catchTags`; this goes when the last legacy caller
 * does. The field order is the wire order every other mapper uses.
 */
export function workspaceApiError(
  error: unknown,
  context: { readonly requestId: string },
): ApiError | null {
  const rejection = workspaceRejectionFor(error);
  if (!rejection) return null;
  return {
    code: rejection.code,
    status: rejection.status,
    message: rejection.message,
    requestId: context.requestId,
    ...(rejection.data === undefined ? {} : { data: rejection.data }),
  };
}

/**
 * The service's word for a setup refusal, translated to the wire's.
 *
 * `setup_trust_required` and `setup_trust_mismatch` are one reason to a client — the hooks on disk
 * are not the hooks that were approved — and the wire names it once. The service keeps them apart
 * because only one of them means "nobody has ever answered for these".
 */
function setupRejectionReason(error: WorktreeSetupError): WorktreeSetupRejectionReason {
  switch (error.code) {
    case 'setup_not_configured':
    case 'setup_config_invalid':
    case 'setup_trust_mismatch':
      return error.code;
    case 'setup_trust_required':
      return 'setup_trust_mismatch';
  }
}
