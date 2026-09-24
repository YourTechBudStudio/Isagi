import { Effect } from 'effect';

import type { CreateCheckpointWorktreeOutput } from '@isagi/contracts';

import type { GitCommandError } from '../../git/index.js';
import type { DatabaseError } from '../../persistence/index.js';
import { type DetachedWorktreeError, WorkspaceService } from '../../workspace/index.js';
import {
  WorkflowRunProjection,
  type WorkflowRunProjectionService,
} from '../read/projection.service.js';
import { WorkflowEngineError } from '../types.js';

/**
 * A detached worktree at a checkpoint's own base commit, in the folder the caller names.
 *
 * The checkpoint picks the repository and the commit; the caller picks only the destination. Reads
 * go through the projection and the only mutation is the workspace's generic detached creation, so
 * the workspace stays ignorant of checkpoints and this module owns no Git or filesystem work. It
 * returns only what it created; the files a checkpoint adds on top are the client's to apply.
 */
export function prepareCheckpointWorktree(input: {
  readonly runId: number;
  readonly checkpointId: string;
  readonly destinationPath: string;
}): Effect.Effect<
  CreateCheckpointWorktreeOutput,
  WorkflowEngineError | DatabaseError | GitCommandError,
  WorkflowRunProjectionService | WorkspaceService
> {
  return Effect.gen(function* () {
    const projection = yield* WorkflowRunProjection;
    const workspace = yield* WorkspaceService;

    // `workflow_run_not_found` and `workflow_checkpoint_not_found` pass through unchanged.
    const { checkpoint } = yield* projection.getCheckpoint(input.runId, input.checkpointId);
    const base = checkpoint.base;
    if (base.kind === 'none') {
      return yield* Effect.fail(
        new WorkflowEngineError({
          code: 'workflow_checkpoint_base_not_git',
          message: `Checkpoint ${input.checkpointId} has no Git base (${base.reason}).`,
          workflowRunId: input.runId,
          checkpointId: input.checkpointId,
        }),
      );
    }

    const created = yield* workspace
      .createDetachedWorktree({
        projectId: base.repositoryId,
        commit: base.commitSha,
        path: input.destinationPath,
      })
      .pipe(
        Effect.catchTag('DetachedWorktreeError', (error) =>
          Effect.fail(
            toCheckpointWorktreeRejection(error, {
              runId: input.runId,
              checkpointId: input.checkpointId,
              commitSha: base.commitSha,
            }),
          ),
        ),
      );

    return {
      runId: input.runId,
      checkpointId: input.checkpointId,
      destinationPath: created.path,
      base,
      worktreeId: created.worktreeId,
    };
  });
}

/** Exhaustive over the workspace reasons, so a new one cannot compile unmapped. */
export function toCheckpointWorktreeRejection(
  error: DetachedWorktreeError,
  context: { readonly runId: number; readonly checkpointId: string; readonly commitSha: string },
): WorkflowEngineError {
  const shared = {
    message: error.message,
    workflowRunId: context.runId,
    checkpointId: context.checkpointId,
  };
  switch (error.reason) {
    case 'project_unavailable':
      return new WorkflowEngineError({
        ...shared,
        code: 'workflow_checkpoint_repository_unavailable',
        projectId: error.projectId,
      });
    case 'destination_rejected':
      return new WorkflowEngineError({
        ...shared,
        code: 'workflow_checkpoint_destination_rejected',
        destinationPath: error.path,
        destinationIssue: error.destinationIssue,
        worktreeId: error.containingWorktreeId,
      });
    case 'commit_not_found':
      return new WorkflowEngineError({
        ...shared,
        code: 'workflow_checkpoint_commit_unavailable',
        projectId: error.projectId,
        commitSha: context.commitSha,
      });
    case 'git_add_failed':
      return new WorkflowEngineError({
        ...shared,
        code: 'workflow_checkpoint_worktree_failed',
        destinationPath: error.path,
        worktreeStage: 'git_add',
        created: error.created,
      });
    case 'registration_failed':
      return new WorkflowEngineError({
        ...shared,
        code: 'workflow_checkpoint_worktree_failed',
        destinationPath: error.path,
        worktreeStage: 'register',
        created: error.created,
      });
  }
}
