import { Cause, Effect, Exit, Option } from 'effect';

import { Git, GitCommandError, GitLive, type GitService } from '../git.command.js';
import {
  classifyProjectRoot,
  normalizeExistingDirectory,
  ProjectPathValidationError,
} from '../project-root.js';

/**
 * Runs one Git operation in a *separate process*, so a test can establish the
 * ambient environment it inherits.
 *
 * Some properties are only observable this way: that a per-call `env` override
 * beats an inherited value, and that inherited values survive when not
 * overridden. Setting `process.env` in-process would be the alternative, and the
 * runtime's test runner shares one process across every file
 * (`--experimental-test-isolation=none`), so that would leak into unrelated
 * suites for as long as the variable were set.
 *
 * Not itself a test file: the runner collects `*.test.ts` only.
 */
type Request =
  | { readonly op: 'run'; readonly args: readonly string[]; readonly env?: Record<string, string> }
  | { readonly op: 'classify'; readonly path: string };

const request = JSON.parse(process.argv[2] ?? '{}') as Request;

const program: Effect.Effect<unknown, unknown, GitService> =
  request.op === 'run'
    ? Effect.gen(function* () {
        const git = yield* Git;
        return yield* git.run(request.args, request.env ? { env: request.env } : {});
      })
    : Effect.gen(function* () {
        const root = yield* normalizeExistingDirectory(request.path);
        return yield* classifyProjectRoot(root);
      });

const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(GitLive)));

if (Exit.isSuccess(exit)) {
  process.stdout.write(`${JSON.stringify({ ok: true, value: exit.value })}\n`);
} else {
  const failure = Option.getOrNull(Cause.failureOption(exit.cause));
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      ...(failure instanceof GitCommandError
        ? { stderr: failure.stderr, failure: failure.failure }
        : {}),
      ...(failure instanceof ProjectPathValidationError ? { code: failure.code } : {}),
    })}\n`,
  );
}
