import type {
  runtimeStateFileFailedErrorSchema,
  WorktreeSetupRejectedError,
  WorktreeSetupRejectionReason,
} from '@isagi/contracts';

import type { ProjectConfigError } from '../projects/index.js';
import type { WorktreeSetupError } from './setup/service.js';
import type { StateFileError } from './state-file.js';

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
