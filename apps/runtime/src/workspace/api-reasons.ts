import { Effect } from 'effect';

import type {
  ProjectDeleteRejectionReason,
  ProjectOperationRejectionReason,
  ProjectRelocationRejectionReason,
  WorkspaceActiveContextRejectionReason,
  WorkspaceReconcileRejectionReason,
  WorktreeDeleteRejectionReason,
  WorktreeOperationRejectionReason,
  WorktreeSetupRejectionReason,
} from '@isagi/contracts';

import type { WorkspaceError } from './errors.js';

/**
 * Which `WorkspaceError` codes each family of workspace endpoints answers, and with which contract reason.
 *
 * Every table lists every code: the contract reason it reads as on those endpoints, or `null` where no service method
 * behind them produces it. Complete tables rather than switches with a default, so a new code fails to compile until
 * every family decides, and no code is ever relabelled as another (arch §2.2). A `null` that is reached is a runtime
 * bug: `withReason` dies, and the request pipeline answers `api_unhandled_error`.
 */
export type ReasonTable<Reason> = { readonly [Code in WorkspaceError['code']]: Reason | null };

/** Rejects with `error`'s reason from `table`, or dies when the table says no method here produces that code. */
export function withReason<Reason, A, E, R>(
  table: ReasonTable<Reason>,
  error: WorkspaceError,
  reject: (reason: Reason) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  const reason = table[error.code];
  return reason === null ? Effect.die(error) : reject(reason);
}

/** `worktrees.branches` and `worktrees.open`. */
export const worktreeOperationReasons: ReasonTable<WorktreeOperationRejectionReason> = {
  project_not_found: 'project_not_found',
  project_not_missing: null,
  project_not_present: 'project_not_present',
  project_path_already_registered: null,
  branch_not_found: 'branch_not_found',
  branch_exists: 'branch_exists',
  worktree_exists: 'worktree_exists',
  new_branch_requires_base: 'new_branch_requires_base',
  invalid_branch_name: 'invalid_branch_name',
  base_ref_not_found: 'base_ref_not_found',
  checkout_path_exists: 'checkout_path_exists',
  checkout_path_registered: 'checkout_path_registered',
  checkout_parent_unavailable: 'checkout_parent_unavailable',
  worktree_not_found: 'worktree_not_found',
  root_worktree_not_deletable: null,
  dirty_checkout_requires_force: null,
  root_worktree_not_found: null,
  command_cleanup_failed: 'command_cleanup_failed',
  pty_teardown_failed: null,
  setup_config_invalid: 'setup_config_invalid',
  setup_trust_required: 'setup_trust_required',
  setup_trust_mismatch: 'setup_trust_mismatch',
  worktrees_not_supported: 'worktrees_not_supported',
  relocation_not_supported: null,
};

/** `worktrees.deletePreflight` and `worktrees.delete`. */
export const worktreeDeleteReasons: ReasonTable<WorktreeDeleteRejectionReason> = {
  project_not_found: 'project_not_found',
  project_not_missing: null,
  project_not_present: 'project_not_present',
  project_path_already_registered: null,
  branch_not_found: null,
  branch_exists: null,
  worktree_exists: null,
  new_branch_requires_base: null,
  invalid_branch_name: null,
  base_ref_not_found: null,
  checkout_path_exists: null,
  checkout_path_registered: null,
  checkout_parent_unavailable: null,
  worktree_not_found: 'worktree_not_found',
  root_worktree_not_deletable: 'root_worktree_not_deletable',
  dirty_checkout_requires_force: 'dirty_checkout_requires_force',
  root_worktree_not_found: 'root_worktree_not_found',
  command_cleanup_failed: 'command_cleanup_failed',
  pty_teardown_failed: 'pty_teardown_failed',
  setup_config_invalid: null,
  setup_trust_required: null,
  setup_trust_mismatch: null,
  worktrees_not_supported: 'worktrees_not_supported',
  relocation_not_supported: null,
};

/** `worktrees.setupPreflight` and `worktrees.setupTrust`, before the setup service is reached. */
export const setupProjectReasons: ReasonTable<WorktreeSetupRejectionReason> = {
  project_not_found: 'project_not_found',
  project_not_missing: null,
  project_not_present: 'project_not_present',
  project_path_already_registered: null,
  branch_not_found: null,
  branch_exists: null,
  worktree_exists: null,
  new_branch_requires_base: null,
  invalid_branch_name: null,
  base_ref_not_found: null,
  checkout_path_exists: null,
  checkout_path_registered: null,
  checkout_parent_unavailable: null,
  worktree_not_found: null,
  root_worktree_not_deletable: null,
  dirty_checkout_requires_force: null,
  root_worktree_not_found: null,
  command_cleanup_failed: null,
  pty_teardown_failed: null,
  setup_config_invalid: null,
  setup_trust_required: null,
  setup_trust_mismatch: null,
  worktrees_not_supported: 'worktrees_not_supported',
  relocation_not_supported: null,
};

/** `projects.relocate`. */
export const relocationReasons: ReasonTable<ProjectRelocationRejectionReason> = {
  project_not_found: 'project_not_found',
  project_not_missing: 'project_not_missing',
  project_not_present: null,
  project_path_already_registered: 'project_path_already_registered',
  branch_not_found: null,
  branch_exists: null,
  worktree_exists: null,
  new_branch_requires_base: null,
  invalid_branch_name: null,
  base_ref_not_found: null,
  checkout_path_exists: null,
  checkout_path_registered: null,
  checkout_parent_unavailable: null,
  worktree_not_found: null,
  root_worktree_not_deletable: null,
  dirty_checkout_requires_force: null,
  root_worktree_not_found: null,
  command_cleanup_failed: 'command_cleanup_failed',
  pty_teardown_failed: null,
  setup_config_invalid: null,
  setup_trust_required: null,
  setup_trust_mismatch: null,
  worktrees_not_supported: null,
  relocation_not_supported: 'relocation_not_supported',
};

/** `workspace.getActiveContext` and `workspace.setActiveContext`. */
export const activeContextReasons: ReasonTable<WorkspaceActiveContextRejectionReason> = {
  project_not_found: 'project_not_found',
  project_not_missing: null,
  project_not_present: 'project_not_present',
  project_path_already_registered: null,
  branch_not_found: null,
  branch_exists: null,
  worktree_exists: null,
  new_branch_requires_base: null,
  invalid_branch_name: null,
  base_ref_not_found: null,
  checkout_path_exists: null,
  checkout_path_registered: null,
  checkout_parent_unavailable: null,
  worktree_not_found: 'worktree_not_found',
  root_worktree_not_deletable: null,
  dirty_checkout_requires_force: null,
  root_worktree_not_found: null,
  command_cleanup_failed: null,
  pty_teardown_failed: null,
  setup_config_invalid: null,
  setup_trust_required: null,
  setup_trust_mismatch: null,
  worktrees_not_supported: null,
  relocation_not_supported: null,
};

/** `workspace.reconcile`. */
export const reconcileReasons: ReasonTable<WorkspaceReconcileRejectionReason> = {
  project_not_found: 'project_not_found',
  project_not_missing: null,
  project_not_present: null,
  project_path_already_registered: null,
  branch_not_found: null,
  branch_exists: null,
  worktree_exists: null,
  new_branch_requires_base: null,
  invalid_branch_name: null,
  base_ref_not_found: null,
  checkout_path_exists: null,
  checkout_path_registered: null,
  checkout_parent_unavailable: null,
  worktree_not_found: null,
  root_worktree_not_deletable: null,
  dirty_checkout_requires_force: null,
  root_worktree_not_found: null,
  command_cleanup_failed: 'command_cleanup_failed',
  pty_teardown_failed: null,
  setup_config_invalid: null,
  setup_trust_required: null,
  setup_trust_mismatch: null,
  worktrees_not_supported: null,
  relocation_not_supported: null,
};

/** `projects.add`: registration fails as a project only when stopping a pruned worktree's commands fails. */
export const projectOperationReasons: ReasonTable<ProjectOperationRejectionReason> = {
  project_not_found: null,
  project_not_missing: null,
  project_not_present: null,
  project_path_already_registered: null,
  branch_not_found: null,
  branch_exists: null,
  worktree_exists: null,
  new_branch_requires_base: null,
  invalid_branch_name: null,
  base_ref_not_found: null,
  checkout_path_exists: null,
  checkout_path_registered: null,
  checkout_parent_unavailable: null,
  worktree_not_found: null,
  root_worktree_not_deletable: null,
  dirty_checkout_requires_force: null,
  root_worktree_not_found: null,
  command_cleanup_failed: 'command_cleanup_failed',
  pty_teardown_failed: null,
  setup_config_invalid: null,
  setup_trust_required: null,
  setup_trust_mismatch: null,
  worktrees_not_supported: null,
  relocation_not_supported: null,
};

/** `projects.delete`: deletion fails as a project only when stopping a worktree's commands fails. */
export const projectDeleteReasons: ReasonTable<ProjectDeleteRejectionReason> = {
  project_not_found: null,
  project_not_missing: null,
  project_not_present: null,
  project_path_already_registered: null,
  branch_not_found: null,
  branch_exists: null,
  worktree_exists: null,
  new_branch_requires_base: null,
  invalid_branch_name: null,
  base_ref_not_found: null,
  checkout_path_exists: null,
  checkout_path_registered: null,
  checkout_parent_unavailable: null,
  worktree_not_found: null,
  root_worktree_not_deletable: null,
  dirty_checkout_requires_force: null,
  root_worktree_not_found: null,
  command_cleanup_failed: 'command_cleanup_failed',
  pty_teardown_failed: null,
  setup_config_invalid: null,
  setup_trust_required: null,
  setup_trust_mismatch: null,
  worktrees_not_supported: null,
  relocation_not_supported: null,
};
