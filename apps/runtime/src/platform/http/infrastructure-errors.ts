import type { ApiError } from '@isagi/contracts';

import { GitCommandError, ProjectPathValidationError } from '../git/index.js';
import { DataDirectoryError, DatabaseError } from '../persistence/index.js';

/**
 * How a platform failure that is not any one domain's rejection reaches a client.
 *
 * Git, the database, the data directory and project paths can fail underneath *any* endpoint that
 * touches a project, so the same failure has to read the same way whichever route hit it. A client that special-cased `git_command_failed` per route, or
 * saw a database failure reported as two different codes, would be responding to which handler ran
 * rather than to what went wrong.
 *
 * **What does not belong here** is any module's error. The platform knows only platform failures;
 * the workspace's project-configuration, worktree-setup and state-file failures are mapped by
 * `workspaceRejections` (`workspace/api-errors.ts`) at the workspace and workflow boundaries.
 *
 * Adding an infrastructure error is one row in each of `infrastructureCodes`, `InfrastructureErrorsByTag` and the
 * switch in `infrastructureRejection`; the compiler enforces the rest.
 */
const infrastructureCodes = {
  ProjectPathValidationError: 'project_path_rejected',
  GitCommandError: 'git_command_failed',
  DatabaseError: 'runtime_database_failed',
  DataDirectoryError: 'runtime_data_directory_failed',
} as const;

interface InfrastructureErrorsByTag {
  readonly ProjectPathValidationError: ProjectPathValidationError;
  readonly GitCommandError: GitCommandError;
  readonly DatabaseError: DatabaseError;
  readonly DataDirectoryError: DataDirectoryError;
}

type InfrastructureCodes = typeof infrastructureCodes;

export type InfrastructureError = InfrastructureErrorsByTag[keyof InfrastructureErrorsByTag];

/** The infrastructure errors an endpoint may let through: exactly those whose contract code it declares. */
export type InfrastructureErrorFor<Code> = {
  [Tag in keyof InfrastructureCodes]: InfrastructureCodes[Tag] extends Code
    ? InfrastructureErrorsByTag[Tag]
    : never;
}[keyof InfrastructureCodes];

/** The contract error an infrastructure failure always reads as, minus the request id the boundary adds. */
export function infrastructureRejection(error: InfrastructureError): Omit<ApiError, 'requestId'> {
  switch (error._tag) {
    case 'ProjectPathValidationError':
      return {
        code: infrastructureCodes.ProjectPathValidationError,
        status: 400,
        message: error.message,
        data: { reason: error.code, path: error.path },
      };
    case 'GitCommandError':
      return {
        code: infrastructureCodes.GitCommandError,
        status: 500,
        message: `git ${error.args.join(' ')} failed${error.stderr ? `: ${error.stderr.trim()}` : ''}`,
        data: { args: [...error.args], cwd: error.cwd ?? null },
      };
    case 'DatabaseError':
      return {
        code: infrastructureCodes.DatabaseError,
        status: 500,
        message: `Database operation failed: ${error.operation}`,
        data: { operation: error.operation },
      };
    case 'DataDirectoryError':
      return {
        code: infrastructureCodes.DataDirectoryError,
        status: 500,
        message: 'Could not prepare the Isagi data directory.',
      };
  }
}

export function isInfrastructureError(error: unknown): error is InfrastructureError {
  return (
    error instanceof ProjectPathValidationError ||
    error instanceof GitCommandError ||
    error instanceof DatabaseError ||
    error instanceof DataDirectoryError
  );
}
