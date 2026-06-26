import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, cp, lstat, mkdir, rm, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { Data, Effect } from 'effect';
import { glob } from 'tinyglobby';

import type { WorktreeSetupResult } from '@isagi/contracts';

import { stripAnsi } from '../lib/ansi.js';
import type { DatabaseError } from '../persistence/index.js';
import type {
  WorktreeHooksConfig,
  WorktreePostCreateHook,
} from '../project-config/project-config.schema.js';
import {
  WorktreeSetupRepository,
  type CreateSetupStepInput,
  type WorktreeSetupRepositoryService,
} from './worktree-setup.repository.js';

const maxOutputExcerptBytes = 32 * 1024;

type StepDetails = Partial<
  Omit<
    CreateSetupStepInput,
    'runId' | 'hookIndex' | 'hookType' | 'status' | 'startedAt' | 'completedAt'
  >
>;

export class WorktreeSetupRunError extends Data.TaggedError('WorktreeSetupRunError')<{
  readonly message: string;
  readonly cause?: unknown;
  readonly details?: StepDetails | undefined;
}> {}

export type WorktreeSetupRunnerError = DatabaseError | WorktreeSetupRunError;

type WorktreePostCreateSetupResult = Extract<
  WorktreeSetupResult,
  { status: 'succeeded' | 'failed' }
>;

export function runPostCreateSetup(input: {
  readonly config: WorktreeHooksConfig;
  readonly hash: string;
  readonly projectRootPath: string;
  readonly worktreeId: number;
  readonly worktreePath: string;
}): Effect.Effect<
  WorktreePostCreateSetupResult,
  WorktreeSetupRunnerError,
  WorktreeSetupRepositoryService
> {
  return Effect.gen(function* () {
    const repository = yield* WorktreeSetupRepository;
    const steps: Omit<CreateSetupStepInput, 'runId'>[] = [];
    let failed: Omit<CreateSetupStepInput, 'runId'> | null = null;
    const runStartedAt = timestamp();

    for (let index = 0; index < input.config.postCreate.length; index += 1) {
      const hook = input.config.postCreate[index]!;
      const step = yield* runHook({
        hook,
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
}

function runHook(input: {
  readonly hook: WorktreePostCreateHook;
  readonly hookIndex: number;
  readonly projectRootPath: string;
  readonly worktreePath: string;
}): Effect.Effect<Omit<CreateSetupStepInput, 'runId'>, WorktreeSetupRunError> {
  const startedAt = timestamp();
  return runHookOperation(input).pipe(
    Effect.map((result) => ({
      hookIndex: input.hookIndex,
      hookType: input.hook.type,
      status: result.status,
      startedAt,
      completedAt: timestamp(),
      ...result.details,
    })),
    Effect.catchAll((error) =>
      Effect.succeed({
        hookIndex: input.hookIndex,
        hookType: input.hook.type,
        status: 'failed' as const,
        startedAt,
        completedAt: timestamp(),
        message: error.message,
        ...error.details,
      }),
    ),
  );
}

function runHookOperation(input: {
  readonly hook: WorktreePostCreateHook;
  readonly projectRootPath: string;
  readonly worktreePath: string;
}): Effect.Effect<
  {
    readonly status: 'succeeded' | 'skipped';
    readonly details: StepDetails;
  },
  WorktreeSetupRunError
> {
  switch (input.hook.type) {
    case 'copy':
      return runCopyHook(input.hook, input.projectRootPath, input.worktreePath);
    case 'symlink':
      return runSymlinkHook(input.hook, input.projectRootPath, input.worktreePath);
    case 'command':
      return runCommandHook(input.hook, input.worktreePath);
  }
}

function runCopyHook(
  hook: Extract<WorktreePostCreateHook, { type: 'copy' }>,
  projectRootPath: string,
  worktreePath: string,
) {
  return Effect.tryPromise({
    try: async () => {
      const srcRoot = resolveRelativeRoot(projectRootPath, hook.src, 'copy.src');
      const destRoot = resolveRelativeRoot(worktreePath, hook.dest, 'copy.dest');
      const matches = await glob([...hook.include], {
        cwd: srcRoot,
        dot: true,
        ignore: [...hook.exclude],
        onlyFiles: true,
      });
      let copied = 0;
      let skipped = 0;
      for (const match of matches) {
        const src = resolveRelativeRoot(srcRoot, match, 'copy.include');
        const dest = resolveRelativeRoot(destRoot, match, 'copy.dest');
        if (!hook.overwrite && (await pathExists(dest))) {
          skipped += 1;
          continue;
        }
        await mkdir(dirname(dest), { recursive: true });
        await cp(src, dest, { force: hook.overwrite, preserveTimestamps: true });
        copied += 1;
      }
      return {
        status: 'succeeded' as const,
        details: {
          src: hook.src,
          dest: hook.dest,
          message: `Copied ${copied} file${copied === 1 ? '' : 's'}${skipped ? `, skipped ${skipped}` : ''}.`,
        },
      };
    },
    catch: (cause) => new WorktreeSetupRunError({ message: errorMessage(cause), cause }),
  });
}

function runSymlinkHook(
  hook: Extract<WorktreePostCreateHook, { type: 'symlink' }>,
  projectRootPath: string,
  worktreePath: string,
) {
  return Effect.tryPromise({
    try: async () => {
      const src = resolveRelativeRoot(projectRootPath, hook.src, 'symlink.src');
      const dest = resolveRelativeRoot(worktreePath, hook.dest, 'symlink.dest');
      const sourceStat = await lstat(src);
      if (await pathExists(dest)) {
        if (!hook.overwrite) {
          return {
            status: 'skipped' as const,
            details: { src: hook.src, dest: hook.dest, message: 'Destination already exists.' },
          };
        }
        await rm(dest, { recursive: true, force: true });
      }
      await mkdir(dirname(dest), { recursive: true });
      await symlink(relative(dirname(dest), src), dest, sourceStat.isDirectory() ? 'dir' : 'file');
      return {
        status: 'succeeded' as const,
        details: { src: hook.src, dest: hook.dest, message: 'Created symlink.' },
      };
    },
    catch: (cause) => new WorktreeSetupRunError({ message: errorMessage(cause), cause }),
  });
}

function runCommandHook(
  hook: Extract<WorktreePostCreateHook, { type: 'command' }>,
  worktreePath: string,
) {
  return Effect.async<
    {
      readonly status: 'succeeded';
      readonly details: StepDetails;
    },
    WorktreeSetupRunError
  >((resume) => {
    let cwd: string;
    let timeoutMs: number;
    try {
      cwd = resolveRelativeRoot(worktreePath, hook.cwd, 'command.cwd');
      timeoutMs = parseDurationMs(hook.timeout);
    } catch (error) {
      resume(
        Effect.fail(
          error instanceof WorktreeSetupRunError
            ? error
            : new WorktreeSetupRunError({ message: errorMessage(error), cause: error }),
        ),
      );
      return;
    }
    const output = new TailBuffer(maxOutputExcerptBytes);
    const child = spawn(hook.run, {
      cwd,
      detached: true,
      env: { ...process.env, ...hook.env },
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let timedOut = false;
    let finished = false;
    let killTimer: NodeJS.Timeout | null = null;
    const terminate = () => {
      if (finished) {
        return;
      }
      killChildProcessGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => {
        if (!finished) {
          killChildProcessGroup(child.pid, 'SIGKILL');
        }
      }, 1000);
      killTimer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timer.unref();

    child.stdout?.on('data', (chunk) => output.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk) => output.push(Buffer.from(chunk)));
    child.on('error', (cause) => {
      finished = true;
      clearTimeout(timer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      resume(Effect.fail(new WorktreeSetupRunError({ message: errorMessage(cause), cause })));
    });
    child.on('close', (exitCode, signal) => {
      finished = true;
      clearTimeout(timer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      const outputExcerpt = output.text();
      if (exitCode === 0 && !timedOut) {
        resume(
          Effect.succeed({
            status: 'succeeded' as const,
            details: {
              command: hook.run,
              message: 'Command completed.',
              outputExcerpt,
            },
          }),
        );
        return;
      }
      const message = timedOut
        ? `Command timed out after ${hook.timeout}.`
        : `Command exited with ${exitCode ?? signal ?? 'unknown status'}.`;
      resume(
        Effect.fail(
          new WorktreeSetupRunError({
            message,
            cause: { exitCode, signal, outputExcerpt },
            details: {
              command: hook.run,
              message,
              exitCode,
              signal,
              outputExcerpt,
            },
          }),
        ),
      );
    });

    return Effect.sync(() => {
      clearTimeout(timer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      terminate();
    });
  });
}

export function parseDurationMs(input: string) {
  const match = /^(\d+)(ms|s|m|h)$/i.exec(input.trim());
  if (!match) {
    throw new WorktreeSetupRunError({
      message: `Invalid duration ${input}. Use values like 500ms, 30s, 10m, or 1h.`,
    });
  }
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  switch (unit) {
    case 'ms':
      return amount;
    case 's':
      return amount * 1000;
    case 'm':
      return amount * 60 * 1000;
    case 'h':
      return amount * 60 * 60 * 1000;
    default:
      throw new WorktreeSetupRunError({ message: `Invalid duration unit ${unit}.` });
  }
}

function resolveRelativeRoot(root: string, candidate: string, field: string) {
  if (isAbsolute(candidate)) {
    throw new WorktreeSetupRunError({ message: `${field} must be relative.` });
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
    throw new WorktreeSetupRunError({ message: `${field} must stay inside its root.` });
  }
  return resolved;
}

async function pathExists(path: string) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function killChildProcessGroup(pid: number | undefined, signal: NodeJS.Signals) {
  if (!pid) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process may already have exited between the close/error path and cleanup.
    }
  }
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
