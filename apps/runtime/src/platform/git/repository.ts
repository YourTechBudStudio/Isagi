import { createHash } from 'node:crypto';

import { Effect } from 'effect';

import { Git } from './command.js';
import { normalizeProjectPath } from './project-root.js';
import { parseGitWorktreeListPorcelain, type GitWorktreeRecord } from './worktree.list.js';

export const listGitWorktrees = Effect.fn('git.listGitWorktrees')(function* (rootPath: string) {
  const git = yield* Git;
  const { stdout } = yield* git.run(['-C', rootPath, 'worktree', 'list', '--porcelain']);
  return normalizeWorktreeRecords(parseGitWorktreeListPorcelain(stdout));
});

export const listLocalBranches = Effect.fn('git.listLocalBranches')(function* (rootPath: string) {
  const git = yield* Git;
  const { stdout } = yield* git.run(['-C', rootPath, 'branch', '--format=%(refname:short)']);
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort((left, right) => left.localeCompare(right));
});

export function branchPathHash(branch: string) {
  return createHash('sha256').update(branch).digest('hex').slice(0, 16);
}

function normalizeWorktreeRecords(records: readonly GitWorktreeRecord[]) {
  return records.map((record) => ({
    ...record,
    path: normalizeProjectPath(record.path),
  }));
}
