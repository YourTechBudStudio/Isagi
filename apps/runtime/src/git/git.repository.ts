import { createHash } from 'node:crypto';

import { Effect } from 'effect';

import { Git } from './git.command.js';
import { normalizeProjectPath } from './project-root.js';
import { parseGitWorktreeListPorcelain, type GitWorktreeRecord } from './worktree.list.js';

export function listGitWorktrees(rootPath: string) {
  return Effect.gen(function* () {
    const git = yield* Git;
    return yield* git
      .run(['-C', rootPath, 'worktree', 'list', '--porcelain'])
      .pipe(
        Effect.map(({ stdout }) => normalizeWorktreeRecords(parseGitWorktreeListPorcelain(stdout))),
      );
  });
}

export function listLocalBranches(rootPath: string) {
  return Effect.gen(function* () {
    const git = yield* Git;
    return yield* git.run(['-C', rootPath, 'branch', '--format=%(refname:short)']).pipe(
      Effect.map(({ stdout }) =>
        stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .sort((left, right) => left.localeCompare(right)),
      ),
    );
  });
}

export function branchPathHash(branch: string) {
  return createHash('sha256').update(branch).digest('hex').slice(0, 16);
}

function normalizeWorktreeRecords(records: readonly GitWorktreeRecord[]) {
  return records.map((record) => ({
    ...record,
    path: normalizeProjectPath(record.path),
  }));
}
