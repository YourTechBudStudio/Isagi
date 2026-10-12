import { constants } from 'node:fs';
import { access, cp, lstat, mkdir, rm, stat, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { Data, Duration, Effect, Option, Result } from 'effect';
import { glob } from 'tinyglobby';

import type { WorktreeSetupResult } from '@isagi/contracts';

import type { DatabaseError } from '../../platform/persistence/index.js';
import { spawnProcessGroup, stripAnsi, terminateGroup } from '../../platform/process/index.js';
import type { WorktreeHooksConfig, WorktreePostCreateHook } from '../../projects/index.js';
import { WorktreeSetupRepository, type CreateSetupStepInput } from './repository.js';

const maxOutputExcerptBytes = 32 * 1024;

/** How long a timed-out command hook gets between `SIGTERM` and `SIGKILL` of its process group. */
const commandTerminationGrace = Duration.seconds(1);

type StepDetails = Partial<
  Omit<
    CreateSetupStepInput,
    'runId' | 'hookIndex' | 'hookType' | 'status' | 'startedAt' | 'completedAt'
  >
>;

type SetupStep = Omit<CreateSetupStepInput, 'runId'>;

type CopyHook = Extract<WorktreePostCreateHook, { type: 'copy' }>;
type SymlinkHook = Extract<WorktreePostCreateHook, { type: 'symlink' }>;
type CommandHook = Extract<WorktreePostCreateHook, { type: 'command' }>;

interface HookOutcome {
  readonly status: 'succeeded' | 'skipped';
  readonly details: StepDetails;
}

/**
 * One hook failed. Never leaves the runner: `runHook` records it as the failed step, so `message` and `details` are
 * what the user sees in the setup result.
 */
export class WorktreeSetupRunError extends Data.TaggedError('WorktreeSetupRunError')<{
  readonly message: string;
  readonly cause?: unknown;
  readonly details?: StepDetails | undefined;
}> {}

type WorktreePostCreateSetupResult =
  | Extract<WorktreeSetupResult, { status: 'succeeded' }>
  | Extract<WorktreeSetupResult, { status: 'failed' }>;

/**
 * Runs the project's post-create hooks in order, stopping at the first failure, and records the run and its steps.
 * A failing hook is a `failed` result, not a failure: the only failure is the database write. Interrupting the run
 * kills a running command hook's whole process group and records nothing.
 */
export const runPostCreateSetup = Effect.fn('workspace.runPostCreateSetup')(function* (input: {
  readonly config: WorktreeHooksConfig;
  readonly hash: string;
  readonly projectRootPath: string;
  readonly worktreeId: number;
  readonly worktreePath: string;
}): Effect.fn.Return<WorktreePostCreateSetupResult, DatabaseError, WorktreeSetupRepository> {
  const repository = yield* WorktreeSetupRepository;
  const steps: SetupStep[] = [];
  let failed: SetupStep | null = null;
  const runStartedAt = timestamp();

  for (let index = 0; index < input.config.postCreate.length; index += 1) {
    const step = yield* runHook({
      hook: input.config.postCreate[index]!,
      hookIndex: index + 1,
      projectRootPath: input.projectRootPath,
      worktreePath: input.worktreePath,
    });
    steps.push(step);
    if (step.status === 'failed') {
      failed = step;
      break;
    }
  }

  const runId = yield* repository.createRunWithSteps({
    run: {
      worktreeId: input.worktreeId,
      lifecycle: 'post_create',
      hookConfigHash: input.hash,
      status: failed ? 'failed' : 'succeeded',
      startedAt: runStartedAt,
      completedAt: timestamp(),
    },
    steps,
  });

  if (failed) {
    return {
      status: 'failed',
      runId,
      failedHookIndex: failed.hookIndex,
      failedHookType: failed.hookType,
      message: failed.message ?? 'Worktree setup hook failed.',
      ...(failed.command ? { command: failed.command } : {}),
      ...(failed.src ? { src: failed.src } : {}),
      ...(failed.dest ? { dest: failed.dest } : {}),
      ...(failed.exitCode !== undefined ? { exitCode: failed.exitCode } : {}),
      ...(failed.signal !== undefined ? { signal: failed.signal } : {}),
      ...(failed.outputExcerpt ? { outputExcerpt: failed.outputExcerpt } : {}),
    } satisfies WorktreeSetupResult;
  }

  return { status: 'succeeded', runId } satisfies WorktreeSetupResult;
});

const runHook = Effect.fnUntraced(function* (input: {
  readonly hook: WorktreePostCreateHook;
  readonly hookIndex: number;
  readonly projectRootPath: string;
  readonly worktreePath: string;
}) {
  const startedAt = timestamp();
  const step = { hookIndex: input.hookIndex, hookType: input.hook.type, startedAt };
  return yield* runHookOperation(input).pipe(
    Effect.map(
      (outcome): SetupStep => ({
        ...step,
        status: outcome.status,
        completedAt: timestamp(),
        ...outcome.details,
      }),
    ),
    Effect.catchTag('WorktreeSetupRunError', (error) =>
      Effect.succeed<SetupStep>({
        ...step,
        status: 'failed',
        completedAt: timestamp(),
        message: error.message,
        ...error.details,
      }),
    ),
  );
});

function runHookOperation(input: {
  readonly hook: WorktreePostCreateHook;
  readonly projectRootPath: string;
  readonly worktreePath: string;
}): Effect.Effect<HookOutcome, WorktreeSetupRunError> {
  switch (input.hook.type) {
    case 'copy':
      return runCopyHook(input.hook, input.projectRootPath, input.worktreePath);
    case 'symlink':
      return runSymlinkHook(input.hook, input.projectRootPath, input.worktreePath);
    case 'command':
      return runCommandHook(input.hook, input.worktreePath);
  }
}

const runCopyHook = Effect.fnUntraced(
  function* (hook: CopyHook, projectRootPath: string, worktreePath: string) {
    const srcRoot = yield* Effect.fromResult(
      resolveRelativeRoot(projectRootPath, hook.src, 'copy.src'),
    );
    const destRoot = yield* Effect.fromResult(
      resolveRelativeRoot(worktreePath, hook.dest, 'copy.dest'),
    );
    const sourceStat = yield* statIfExists(srcRoot);
    if (!sourceStat) {
      return yield* new WorktreeSetupRunError({
        message: `copy.src ${hook.src} does not exist in the project root.`,
      });
    }

    // A file source copies straight to dest; include/exclude only filter directory sources.
    const copies: { readonly src: string; readonly dest: string }[] = [];
    if (sourceStat.isDirectory()) {
      const matches = yield* fsTry(() =>
        glob([...(hook.include ?? ['**/*'])], {
          cwd: srcRoot,
          dot: true,
          ignore: [...(hook.exclude ?? [])],
          onlyFiles: true,
        }),
      );
      for (const match of matches) {
        copies.push({
          src: yield* Effect.fromResult(resolveRelativeRoot(srcRoot, match, 'copy.include')),
          dest: yield* Effect.fromResult(resolveRelativeRoot(destRoot, match, 'copy.dest')),
        });
      }
    } else {
      if (hook.include || hook.exclude) {
        return yield* new WorktreeSetupRunError({
          message: `copy.include and copy.exclude apply to directory sources only; copy.src ${hook.src} is a file.`,
        });
      }
      copies.push({ src: srcRoot, dest: destRoot });
    }

    let copied = 0;
    let skipped = 0;
    for (const { src, dest } of copies) {
      if (!hook.overwrite && (yield* pathExists(dest))) {
        skipped += 1;
        continue;
      }
      yield* fsTry(() => mkdir(dirname(dest), { recursive: true }));
      yield* fsTry(() => cp(src, dest, { force: hook.overwrite, preserveTimestamps: true }));
      copied += 1;
    }
    return {
      status: 'succeeded',
      details: {
        src: hook.src,
        dest: hook.dest,
        message: `Copied ${copied} file${copied === 1 ? '' : 's'}${skipped ? `, skipped ${skipped}` : ''}.`,
      },
    } satisfies HookOutcome;
  },
  // Every copy failure names the hook's src and dest, so the failed step says which copy broke.
  (effect, hook) =>
    Effect.mapError(
      effect,
      (error) =>
        new WorktreeSetupRunError({
          message: error.message,
          cause: error.cause,
          details: { src: hook.src, dest: hook.dest },
        }),
    ),
);

const runSymlinkHook = Effect.fnUntraced(function* (
  hook: SymlinkHook,
  projectRootPath: string,
  worktreePath: string,
) {
  const src = yield* Effect.fromResult(
    resolveRelativeRoot(projectRootPath, hook.src, 'symlink.src'),
  );
  const dest = yield* Effect.fromResult(
    resolveRelativeRoot(worktreePath, hook.dest, 'symlink.dest'),
  );
  const sourceStat = yield* fsTry(() => lstat(src));
  if (yield* pathExists(dest)) {
    if (!hook.overwrite) {
      return {
        status: 'skipped',
        details: { src: hook.src, dest: hook.dest, message: 'Destination already exists.' },
      } satisfies HookOutcome;
    }
    yield* fsTry(() => rm(dest, { recursive: true, force: true }));
  }
  yield* fsTry(() => mkdir(dirname(dest), { recursive: true }));
  yield* fsTry(() =>
    symlink(relative(dirname(dest), src), dest, sourceStat.isDirectory() ? 'dir' : 'file'),
  );
  return {
    status: 'succeeded',
    details: { src: hook.src, dest: hook.dest, message: 'Created symlink.' },
  } satisfies HookOutcome;
});

/**
 * Runs the hook's command line through the shell as the leader of its own process group, keeping the tail of its
 * merged output. Past its `timeout` the group gets `SIGTERM`, then `SIGKILL` after `commandTerminationGrace`; the
 * step records the leader's exit either way. Interruption closes the scope that owns the group, which `SIGKILL`s it.
 */
const runCommandHook = Effect.fnUntraced(function* (hook: CommandHook, worktreePath: string) {
  // The hook's own fields are checked before anything is spawned.
  const cwd = yield* Effect.fromResult(resolveRelativeRoot(worktreePath, hook.cwd, 'command.cwd'));
  const timeout = yield* Effect.fromResult(parseDuration(hook.timeout));
  const output = new TailBuffer(maxOutputExcerptBytes);

  const { exit, timedOut } = yield* Effect.scoped(
    Effect.gen(function* () {
      const group = yield* spawnProcessGroup({
        command: hook.run,
        shell: true,
        cwd,
        env: { ...process.env, ...hook.env },
        onOutput: (chunk) => output.push(chunk),
      });
      const settled = yield* Effect.timeoutOption(group.exit, timeout);
      if (Option.isSome(settled)) return { exit: settled.value, timedOut: false };
      yield* terminateGroup(group, commandTerminationGrace);
      // Waits for `close`, so the step carries the signal that stopped the leader and every chunk written before it.
      return { exit: yield* group.exit, timedOut: true };
    }),
  ).pipe(
    // The spawn error's own message (`spawn /bin/sh ENOENT`), as the failed step has always reported it.
    Effect.mapError(
      (error) => new WorktreeSetupRunError({ message: errorMessage(error.cause), cause: error }),
    ),
  );

  const outputExcerpt = output.text();
  if (exit.exitCode === 0 && !timedOut) {
    return {
      status: 'succeeded',
      details: { command: hook.run, message: 'Command completed.', outputExcerpt },
    } satisfies HookOutcome;
  }
  const message = timedOut
    ? `Command timed out after ${hook.timeout}.`
    : `Command exited with ${exit.exitCode ?? exit.signal ?? 'unknown status'}.`;
  return yield* new WorktreeSetupRunError({
    message,
    cause: { exitCode: exit.exitCode, signal: exit.signal, outputExcerpt },
    details: {
      command: hook.run,
      message,
      exitCode: exit.exitCode,
      signal: exit.signal,
      outputExcerpt,
    },
  });
});

/** Parses a hook duration such as `500ms`, `30s`, `10m` or `1h`. */
function parseDuration(input: string): Result.Result<Duration.Duration, WorktreeSetupRunError> {
  const match = /^(\d+)(ms|s|m|h)$/i.exec(input.trim());
  if (!match) {
    return Result.fail(
      new WorktreeSetupRunError({
        message: `Invalid duration ${input}. Use values like 500ms, 30s, 10m, or 1h.`,
      }),
    );
  }
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  switch (unit) {
    case 'ms':
      return Result.succeed(Duration.millis(amount));
    case 's':
      return Result.succeed(Duration.seconds(amount));
    case 'm':
      return Result.succeed(Duration.minutes(amount));
    case 'h':
      return Result.succeed(Duration.hours(amount));
    default:
      return Result.fail(new WorktreeSetupRunError({ message: `Invalid duration unit ${unit}.` }));
  }
}

/** Resolves a hook path that must be relative to `root` and stay inside it. */
function resolveRelativeRoot(
  root: string,
  candidate: string,
  field: string,
): Result.Result<string, WorktreeSetupRunError> {
  if (isAbsolute(candidate)) {
    return Result.fail(new WorktreeSetupRunError({ message: `${field} must be relative.` }));
  }
  const resolved = resolve(root, candidate);
  const relativePath = relative(root, resolved);
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath.startsWith('../') ||
    relativePath.startsWith('..\\') ||
    isAbsolute(relativePath)
  ) {
    return Result.fail(
      new WorktreeSetupRunError({ message: `${field} must stay inside its root.` }),
    );
  }
  return Result.succeed(resolved);
}

/** A filesystem call whose failure fails the hook with the error's own message. */
function fsTry<A>(operation: () => Promise<A>) {
  return Effect.tryPromise({
    try: operation,
    catch: (cause) => new WorktreeSetupRunError({ message: errorMessage(cause), cause }),
  });
}

function statIfExists(path: string) {
  return fsTry(async () => {
    try {
      return await stat(path);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw cause;
    }
  });
}

function pathExists(path: string) {
  return Effect.promise(() =>
    access(path, constants.F_OK).then(
      () => true,
      () => false,
    ),
  );
}

function timestamp() {
  return new Date().toISOString();
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

// Captures stdout and stderr merged into a single near-chronological stream so
// the diagnostic reads like the terminal the user would have seen. ANSI escape
// codes are stripped on read (over the whole buffer, never per-chunk, so escape
// sequences split across data events aren't mangled) since the palette renders
// the excerpt as plain text. When the buffer overflows we keep only the tail and
// drop the partial first line, so a head-truncated excerpt starts at a clean
// line boundary rather than mid-escape-sequence (which strip couldn't match
// without its leading ESC byte).
class TailBuffer {
  private buffer = Buffer.alloc(0);
  private truncated = false;

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > this.maxBytes) {
      this.buffer = this.buffer.subarray(this.buffer.length - this.maxBytes);
      this.truncated = true;
    }
  }

  text() {
    let buffer = this.buffer;
    if (this.truncated) {
      const newlineIndex = buffer.indexOf(0x0a);
      if (newlineIndex !== -1) {
        buffer = buffer.subarray(newlineIndex + 1);
      }
    }
    return stripAnsi(buffer.toString('utf8'));
  }
}
