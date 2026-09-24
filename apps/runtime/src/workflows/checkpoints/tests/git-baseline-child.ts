import { Effect, Exit } from 'effect';

import { Git, GitLive } from '../../../git/git.command.js';
import { inspectBaseline, listBaseTree, surveyDirtyPaths } from '../git-baseline.js';

/**
 * Runs a checkpoint's Git reads against one worktree in a *separate process*, so a test can set the
 * ambient environment those reads inherit. The runtime's test runner shares one process across
 * every file, so setting `process.env` in-process would leak into unrelated suites.
 *
 * Not itself a test file: the runner collects `*.test.ts` only.
 */

const { worktreePath, roots } = JSON.parse(process.argv[2] ?? '{}') as {
  readonly worktreePath: string;
  readonly roots: readonly string[];
};

const program = Effect.gen(function* () {
  const git = yield* Git;
  const baseline = yield* inspectBaseline(git, worktreePath);
  const tree =
    baseline.head === null ? [] : yield* listBaseTree(git, worktreePath, baseline.head, roots);
  const survey = yield* surveyDirtyPaths(git, worktreePath, []);
  return { head: baseline.head, tree: tree.map((entry) => entry.path), survey };
});

const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(GitLive)));
process.stdout.write(
  `${JSON.stringify(Exit.isSuccess(exit) ? { ok: true, value: exit.value } : { ok: false, cause: String(exit.cause) })}\n`,
);
