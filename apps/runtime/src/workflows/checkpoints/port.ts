import { Effect } from 'effect';

import type { GitService } from '../../git/index.js';
import type { WorkspaceServiceShape } from '../../workspace/index.js';
import type { CheckpointsPort } from '../engine/runtime.js';
import type { WorkflowContentStoreService } from '../store/content-store.js';

/** The live checkpoints port over the owning services. Tests build it the same way. */
export function makeCheckpointsPort(input: {
  readonly git: GitService;
  readonly content: WorkflowContentStoreService;
  readonly workspace: Pick<WorkspaceServiceShape, 'createDetachedWorktree' | 'checkNewDirectory'>;
}): CheckpointsPort {
  return {
    headCommit: (checkoutPath) => headCommit(input.git, checkoutPath),
    content: input.content,
    createDetachedWorktree: input.workspace.createDetachedWorktree,
    checkNewDirectory: input.workspace.checkNewDirectory,
  };
}

/**
 * `rev-parse --verify --quiet HEAD`: Git's quiet "no such object" (exit 1) is an unborn repository
 * and means no commit. Every other failure passes through, so a broken repository fails the capture
 * instead of silently recording no commit.
 */
function headCommit(git: GitService, checkoutPath: string) {
  return git.run(['-C', checkoutPath, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).pipe(
    Effect.map(({ stdout }): string | null => stdout.trim()),
    Effect.catchIf(
      (error) => error.failure.kind === 'exited' && error.failure.exitCode === 1,
      () => Effect.succeed(null),
    ),
  );
}
