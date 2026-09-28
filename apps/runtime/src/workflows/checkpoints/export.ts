import { mkdir } from 'node:fs/promises';

import { Effect } from 'effect';

import type { ExportWorkflowCheckpointOutput } from '@isagi/contracts';

import type { DatabaseError } from '../../persistence/index.js';
import type { DetachedWorktreeError } from '../../workspace/index.js';
import type { EngineRuntime } from '../engine/runtime.js';
import { WorkflowEngineError } from '../errors.js';
import { errorMessage } from '../state/pure.js';
import { getCheckpoint, type CheckpointScope } from '../store/checkpoints.js';
import { fromJson, type CheckpointRow } from '../store/rows.js';
import { getRun } from '../store/runs.js';
import { mirrorScopes, MirrorFailed } from './mirror.js';

/**
 * Rebuilding a checkpoint in a new folder, in one call.
 *
 * ```text
 * commit recorded → a detached Isagi worktree at that commit, in the run's project
 * no commit       → an empty plain folder (after the same new-directory check)
 * then            → every captured scope mirrored exactly (see mirror.ts)
 * ```
 *
 * Checks come first and refuse without writing anything. The canonical destination is then reserved
 * in memory until the export ends, so two exports can never write into one folder (the runtime is
 * the only writer). Once something exists on disk, a failure is `workflow_checkpoint_export_failed`,
 * naming the step and path, and nothing is cleaned up.
 */
export function exportCheckpoint(
  rt: EngineRuntime,
  checkpointId: number,
  destinationPath: string,
): Effect.Effect<ExportWorkflowCheckpointOutput, unknown> {
  return Effect.gen(function* () {
    const checkpoint = yield* rt.read('workflow_read_checkpoint', (db) =>
      getCheckpoint(db, checkpointId),
    );
    if (!checkpoint) return yield* Effect.fail(checkpointNotFound(checkpointId));
    // A checkpoint's run always exists: deleting a run deletes its checkpoints.
    const run = yield* rt.read('workflow_read_run', (db) => getRun(db, checkpoint.runId));
    if (!run) return yield* Effect.fail(checkpointNotFound(checkpointId));
    const port = rt.deps.checkpoints;

    // Checked for both kinds so the canonical path can be reserved before anything is created.
    const destination = yield* checkDestination(rt, checkpoint, destinationPath);
    if (rt.exportDestinations.has(destination)) {
      return yield* Effect.fail(
        destinationRejected(
          checkpoint.id,
          destination,
          'not_empty',
          `Another checkpoint export is already writing to ${destination}.`,
        ),
      );
    }
    rt.exportDestinations.add(destination);

    return yield* Effect.gen(function* () {
      const created =
        checkpoint.commitSha === null
          ? yield* createFolder(checkpoint, destination)
          : yield* port
              .createDetachedWorktree({
                projectId: run.projectId,
                commit: checkpoint.commitSha,
                path: destination,
              })
              .pipe(
                Effect.map((worktree) => ({
                  path: worktree.path,
                  worktreeId: worktree.worktreeId,
                })),
                Effect.catchTag('DetachedWorktreeError', (error) =>
                  Effect.fail(fromDetachedError(checkpoint, error)),
                ),
              );

      const scopes = fromJson<CheckpointScope[]>(checkpoint.scopesJson);
      yield* Effect.tryPromise({
        try: () => mirrorScopes(created.path, scopes, port.content),
        catch: (cause) =>
          new WorkflowEngineError({
            code: 'workflow_checkpoint_export_failed',
            message: `Created ${created.path}${created.worktreeId === null ? '' : ` (worktree ${created.worktreeId})`}, but restoring ${cause instanceof MirrorFailed ? `'${cause.path}'` : 'the captured files'} failed: ${errorMessage(cause)} The destination has content and was left as it is.`,
            checkpointId,
            worktreeId: created.worktreeId ?? undefined,
          }),
      });
      return { destinationPath: created.path, worktreeId: created.worktreeId };
    }).pipe(Effect.ensuring(Effect.sync(() => rt.exportDestinations.delete(destination))));
  });
}

/** The shared new-directory rule; returns the canonical path. */
function checkDestination(
  rt: EngineRuntime,
  checkpoint: CheckpointRow,
  destinationPath: string,
): Effect.Effect<string, WorkflowEngineError | DatabaseError> {
  return rt.deps.checkpoints
    .checkNewDirectory(destinationPath)
    .pipe(
      Effect.catchTag('NewDirectoryRejected', (rejected) =>
        Effect.fail(
          destinationRejected(checkpoint.id, rejected.path, rejected.issue, rejected.message),
        ),
      ),
    );
}

function createFolder(
  checkpoint: CheckpointRow,
  path: string,
): Effect.Effect<{ path: string; worktreeId: null }, WorkflowEngineError> {
  return Effect.tryPromise({
    try: () => mkdir(path, { recursive: true }),
    catch: (cause) =>
      new WorkflowEngineError({
        code: 'workflow_checkpoint_export_failed',
        message: `Could not create the folder ${path}: ${errorMessage(cause)}`,
        checkpointId: checkpoint.id,
      }),
  }).pipe(Effect.as({ path, worktreeId: null }));
}

function fromDetachedError(checkpoint: CheckpointRow, error: DetachedWorktreeError) {
  switch (error.reason) {
    case 'destination_rejected':
      return destinationRejected(
        checkpoint.id,
        error.path,
        error.destinationIssue ?? 'inaccessible',
        error.message,
      );
    case 'project_unavailable':
    case 'commit_not_found':
      return new WorkflowEngineError({
        code: 'workflow_checkpoint_commit_unavailable',
        message: `Checkpoint ${checkpoint.id} cannot be exported: ${error.message} Isagi keeps no reference to a checkpoint's commit, so a squashed or discarded commit cannot be restored.`,
        checkpointId: checkpoint.id,
        projectId: error.projectId,
        commitSha: checkpoint.commitSha ?? undefined,
      });
    case 'git_add_failed':
    case 'registration_failed':
      return new WorkflowEngineError({
        code: 'workflow_checkpoint_export_failed',
        message: `${error.message} ${error.created ? 'The destination has content and was left as it is.' : 'The destination is empty.'}`,
        checkpointId: checkpoint.id,
        projectId: error.projectId,
      });
  }
}

function destinationRejected(
  checkpointId: number,
  path: string,
  issue: NonNullable<WorkflowEngineError['destination']>['issue'],
  message: string,
) {
  return new WorkflowEngineError({
    code: 'workflow_checkpoint_destination_rejected',
    message,
    checkpointId,
    destination: { path, issue },
  });
}

export function checkpointNotFound(checkpointId: number) {
  return new WorkflowEngineError({
    code: 'workflow_checkpoint_not_found',
    message: `Checkpoint ${checkpointId} was not found.`,
    checkpointId,
  });
}
