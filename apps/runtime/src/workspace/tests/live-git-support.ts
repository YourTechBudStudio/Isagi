import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Effect } from 'effect';

import { createFixtureWorkspace, type FixtureWorkspace } from '../../git/tests/fixtures.js';
import type { RuntimeDatabaseService } from '../../persistence/index.js';
import type { WorkspaceRepositoryService } from '../workspace.repository.js';
import { WorkspaceService } from '../workspace.service.js';
import { type LiveWorkspaceOptions, runWithLiveWorkspace } from './live-workspace-support.js';

/**
 * A real Git repository, registered as a real project, driven through the real workspace service.
 *
 * `live-workspace-support.ts` already gives the service a real database and a real `GitLive`, and
 * `git/tests/fixtures.ts` already builds isolated real repositories. What was missing is the pair
 * of them: everything worktree creation decides — whether a branch exists, what a ref resolves to,
 * whether `git worktree add` succeeds — is a question only Git can answer, and a hand-written
 * `GitService` double answers it by restating the assumption under test.
 *
 * Trust and hook outcomes are the deliberate exception. They live in trust rows and hook config,
 * not in the repository, so they arrive through `LiveWorkspaceOptions.worktreeSetup`.
 */
export interface GitProjectFixture {
  readonly workspace: FixtureWorkspace;
  readonly rootPath: string;
  /** Runs fixture-isolated `git` inside the repository. Never used by code under test. */
  readonly git: (args: readonly string[]) => string;
  /** Writes a file and commits it, returning the new commit's full hash. */
  readonly commit: (message: string) => string;
  readonly head: () => string;
  readonly cleanup: () => void;
}

export function createGitProjectFixture(label: string): GitProjectFixture {
  const workspace = createFixtureWorkspace(label);
  const rootPath = workspace.directory('project');
  const git = (args: readonly string[]) => workspace.git(rootPath, args);

  git(['init']);
  let counter = 0;
  const commit = (message: string) => {
    counter += 1;
    writeFileSync(join(rootPath, `file-${counter}.txt`), `${message}\n`);
    git(['add', '.']);
    git(['commit', '-m', message]);
    return git(['rev-parse', 'HEAD']).trim();
  };
  commit('initial');

  return {
    workspace,
    rootPath,
    git,
    commit,
    head: () => git(['rev-parse', 'HEAD']).trim(),
    cleanup: workspace.cleanup,
  };
}

/**
 * Registers `rootPath` as a project and hands `build` its id.
 *
 * Registration goes through the service rather than the repository so the project row, its root
 * worktree and the reconciled Git facts are the ones the product would have written.
 */
export function withRegisteredGitProject<A, E>(
  label: string,
  rootPath: string,
  options: LiveWorkspaceOptions,
  build: (
    projectId: number,
  ) => Effect.Effect<A, E, RuntimeDatabaseService | WorkspaceRepositoryService | WorkspaceService>,
) {
  return runWithLiveWorkspace(
    label,
    options,
    Effect.gen(function* () {
      const service = yield* WorkspaceService;
      const added = yield* service.registerProject({ path: rootPath });
      return yield* build(added.projectId);
    }),
  );
}
