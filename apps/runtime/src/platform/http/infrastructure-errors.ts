import type { ApiError } from '@isagi/contracts';

import { GitCommandError, ProjectPathValidationError } from '../git/index.js';
import { DataDirectoryError, DatabaseError } from '../persistence/index.js';
import type { ApiRouteContext } from './errors.js';

/**
 * How a platform failure that is not any one domain's rejection reaches a client.
 *
 * Git, the database, the data directory and project paths can fail underneath *any* endpoint that
 * touches a project, so the same failure has to read the same way whichever route hit it. A client that special-cased `git_command_failed` per route, or
 * saw a database failure reported as two different codes, would be responding to which handler ran
 * rather than to what went wrong.
 *
 * Returning `null` rather than a fallback is deliberate: it says "not mine", and leaves each
 * boundary to decide what an unrecognised error means there. Every caller already ends in its own
 * logged `api_unhandled_error`, which stays the single place an unknown failure is reported.
 *
 * **What does not belong here** is any module's error. The platform knows only platform failures;
 * the workspace's project-configuration, worktree-setup and state-file failures are mapped by
 * `workspaceRejections` (`workspace/api-errors.ts`) at the workspace and workflow boundaries.
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
