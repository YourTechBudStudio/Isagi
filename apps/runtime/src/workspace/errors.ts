import { Data } from 'effect';

import type { ProjectOrderRejectionReason, WorktreeOrderRejectionReason } from '@isagi/contracts';

import type { GitCommandError, ProjectPathValidationError } from '../platform/git/index.js';
import type { DatabaseError } from '../platform/persistence/index.js';
import type { ProjectConfigError } from '../projects/index.js';
import type { WorktreeSetupRunError } from './setup/runner.js';
import type { WorktreeSetupError } from './setup/service.js';
import type { StateFileError } from './state-file.js';

/**
 * A workspace request the service refused. `code` is shared by every workspace method; each endpoint maps the codes
 * its method can produce onto its own contract reason (`api.ts`), and treats any other code as a runtime bug.
 */
export class WorkspaceError extends Data.TaggedError('WorkspaceError')<{
  readonly code:
    | 'project_not_found'
    | 'project_not_missing'
    | 'project_not_present'
    | 'project_path_already_registered'
    | 'branch_not_found'
    /** A local branch of that name already exists, and the caller asked to create a new one. */
    | 'branch_exists'
    /** A worktree is already checked out on that branch, and the caller asked to create a new one. */
    | 'worktree_exists'
    | 'new_branch_requires_base'
    | 'invalid_branch_name'
    | 'base_ref_not_found'
    | 'checkout_path_exists'
    | 'checkout_path_registered'
    | 'checkout_parent_unavailable'
    | 'worktree_not_found'
    | 'root_worktree_not_deletable'
    | 'dirty_checkout_requires_force'
    | 'root_worktree_not_found'
    | 'command_cleanup_failed'
    | 'pty_teardown_failed'
    | 'setup_config_invalid'
    | 'setup_trust_required'
    | 'setup_trust_mismatch'
    | 'worktrees_not_supported'
    | 'relocation_not_supported';
  readonly message: string;
  readonly branch?: string | undefined;
  readonly conflictingProjectId?: number | undefined;
  readonly path?: string | undefined;
  readonly projectId?: number | undefined;
  readonly worktreeId?: number | undefined;
  readonly cause?: unknown;
}> {}

/**
 * Reorder rejections stay out of `WorkspaceError` on purpose: they carry the contract reason directly, and only the
 * two reorder endpoints can ever be asked to encode one.
 */
export class ProjectOrderError extends Data.TaggedError('ProjectOrderError')<{
  readonly reason: ProjectOrderRejectionReason;
  readonly message: string;
  readonly projectId: number;
  readonly beforeProjectId?: number | undefined;
}> {}

export class WorktreeOrderError extends Data.TaggedError('WorktreeOrderError')<{
  readonly reason: WorktreeOrderRejectionReason;
  readonly message: string;
  readonly projectId: number;
  readonly worktreeId: number;
  readonly beforeWorktreeId?: number | undefined;
}> {}

/**
 * What the shared workspace methods declare. `WorktreeSetupRunError` no longer leaves the setup runner (a failed hook
 * is a `failed` setup result), but stays in the union while other modules still name it.
 */
export type WorkspaceServiceError =
  | DatabaseError
  | GitCommandError
  | ProjectConfigError
  | ProjectPathValidationError
  | StateFileError
  | WorktreeSetupError
  | WorktreeSetupRunError
  | WorkspaceError;

/**
 * Reorder failures extend the shared union per method instead of joining it, so
 * only the reorder endpoints can ever be asked to encode an order rejection.
 */
export type MoveProjectOrderServiceError = WorkspaceServiceError | ProjectOrderError;
export type MoveWorktreeOrderServiceError = WorkspaceServiceError | WorktreeOrderError;
