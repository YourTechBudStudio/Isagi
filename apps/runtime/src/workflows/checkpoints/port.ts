import { Effect } from 'effect';

import type { Git } from '../../platform/git/index.js';
import type { WorkspaceService } from '../../workspace/index.js';
import type { CheckpointsPort } from '../engine/runtime.js';
import type { WorkflowContentStore } from '../store/content-store.js';

/** The live checkpoints port over the owning services. Tests build it the same way. */
export function makeCheckpointsPort(input: {
  readonly git: Git['Service'];
  readonly content: WorkflowContentStore['Service'];
  readonly workspace: Pick<
    WorkspaceService['Service'],
    'createDetachedWorktree' | 'checkNewDirectory'
  >;
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
function headCommit(git: Git['Service'], checkoutPath: string) {
  return git.run(['-C', checkoutPath, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).pipe(
    Effect.map(({ stdout }): string | null => stdout.trim()),
    Effect.catchIf(
      (error) => error.failure.kind === 'exited' && error.failure.exitCode === 1,
      () => Effect.succeed(null),
    ),
  );
}
