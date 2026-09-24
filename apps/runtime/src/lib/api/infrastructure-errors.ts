import type { ApiError, WorktreeSetupRejectionReason } from '@isagi/contracts';

import { GitCommandError, ProjectPathValidationError } from '../../git/index.js';
import { DataDirectoryError, DatabaseError, StateFileError } from '../../persistence/index.js';
import { ProjectConfigError } from '../../project-config/project-config.service.js';
import { WorktreeSetupError } from '../../worktree-setup/index.js';
import type { ApiRouteContext } from './errors.js';

/**
 * How a runtime failure that is not any one domain's rejection reaches a client.
 *
 * Git, the database, the state file, the data directory, project paths and project configuration
 * can fail underneath *any* endpoint that touches a project, so the same failure has to read the
 * same way whichever route hit it. A client that special-cased `git_command_failed` per route, or
 * saw a database failure reported as two different codes, would be responding to which handler ran
 * rather than to what went wrong.
 *
 * Returning `null` rather than a fallback is deliberate: it says "not mine", and leaves each
 * boundary to decide what an unrecognised error means there. Every caller already ends in its own
 * logged `api_unhandled_error`, which stays the single place an unknown failure is reported.
 *
 * **What does not belong here** is anything whose answer depends on the endpoint. `worktrees.open`
 * reports a setup-configuration failure as `worktree_open_rejected` rather than
 * `worktree_setup_rejected`, because there the setup was a step of opening rather than the thing
 * asked for. Those stay at their own boundary and take precedence over this helper.
 */
export function infrastructureApiError(error: unknown, context: ApiRouteContext): ApiError | null {
  if (error instanceof ProjectPathValidationError) {
    return {
      code: 'project_path_rejected',
      status: 400,
      message: error.message,
      requestId: context.requestId,
      data: { reason: error.code, path: error.path },
    };
  }

  if (error instanceof ProjectConfigError) {
    return {
      code: 'worktree_setup_rejected',
      status: 400,
      message: error.message,
      requestId: context.requestId,
      data: {
        reason: 'setup_config_invalid',
        ...(error.projectId ? { projectId: error.projectId } : {}),
      },
    };
  }

  if (error instanceof WorktreeSetupError) {
    return {
      code: 'worktree_setup_rejected',
      status: 400,
      message: error.message,
      requestId: context.requestId,
      data: {
        reason: setupRejectionReason(error),
        ...(error.projectId ? { projectId: error.projectId } : {}),
        ...(error.hash ? { hash: error.hash } : {}),
      },
    };
  }

  if (error instanceof GitCommandError) {
    return {
      code: 'git_command_failed',
      status: 500,
      message: `git ${error.args.join(' ')} failed${error.stderr ? `: ${error.stderr.trim()}` : ''}`,
      requestId: context.requestId,
      data: { args: [...error.args], cwd: error.cwd ?? null },
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

  if (error instanceof StateFileError) {
    return {
      code: 'runtime_state_file_failed',
      status: 500,
      message: `State file operation failed: ${error.operation}`,
      requestId: context.requestId,
      data: { operation: error.operation },
    };
  }

  if (error instanceof DataDirectoryError) {
    return {
      code: 'runtime_data_directory_failed',
      status: 500,
      message: 'Could not prepare the Isagi data directory.',
      requestId: context.requestId,
    };
  }

  return null;
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
