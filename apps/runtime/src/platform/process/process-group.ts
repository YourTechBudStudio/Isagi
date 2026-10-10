import { spawn, type ChildProcess } from 'node:child_process';

import { Data, Deferred, Effect, Exit, Option, type Duration } from 'effect';

/** The process could not be started (`spawn` threw, or the child emitted `error`, e.g. `ENOENT`). */
export class ProcessSpawnFailed extends Data.TaggedError('ProcessSpawnFailed')<{
  readonly command: string;
  readonly systemErrorCode: string | null;
  readonly cause: unknown;
}> {
  override get message() {
    return `Could not start ${this.command}${this.systemErrorCode ? ` (${this.systemErrorCode})` : ''}`;
  }
}

export interface ProcessExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface ProcessGroup {
  /** `undefined` only when the child never started (its `exit` then fails with `ProcessSpawnFailed`). */
  readonly pid: number | undefined;
  /** Completes once the leader has exited and closed its stdio, so every `onOutput` chunk has been delivered. */
  readonly exit: Effect.Effect<ProcessExit, ProcessSpawnFailed>;
  /** Signals the whole group. A group that is already gone is not an error. */
  readonly signal: (signal: NodeJS.Signals) => Effect.Effect<void>;
}

export interface ProcessGroupSpec {
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  /** Runs `command` through the platform shell (a user-authored command line). */
  readonly shell?: boolean | undefined;
  readonly cwd: string;
  /** The child's complete environment (not merged over `process.env`). */
  readonly env: NodeJS.ProcessEnv;
  /** Called synchronously for every output chunk; keep it to buffering (truncation, tail buffers). */
  readonly onOutput: (chunk: Buffer, stream: 'stdout' | 'stderr') => void;
}

/**
 * Spawns a child as the leader of its own process group (stdin ignored, stdout/stderr piped to `onOutput`), for
 * commands that may start children of their own: user-shell probes and worktree setup hooks.
 *
 * The group is owned by the caller's scope: when the scope closes before the leader has exited (interruption,
 * timeout, failure elsewhere), the whole group is `SIGKILL`ed, so no process tree outlives its caller. Timeouts are the
 * caller's: `Effect.timeoutOption(group.exit, limit)`, then `terminateGroup` or `group.signal`.
 */
export const spawnProcessGroup = Effect.fn('process.spawnProcessGroup')(function* (
  spec: ProcessGroupSpec,
) {
  const { child, exited } = yield* Effect.acquireRelease(startGroupLeader(spec), (leader) =>
    Deferred.isDone(leader.exited).pipe(
      Effect.flatMap((done) =>
        done ? Effect.void : Effect.sync(() => signalGroup(leader.child, 'SIGKILL')),
      ),
    ),
  );
  return {
    pid: child.pid,
    exit: Deferred.await(exited),
    signal: (signal) => Effect.sync(() => signalGroup(child, signal)),
  } satisfies ProcessGroup;
});

/**
 * Asks the group to stop: `SIGTERM`, then `SIGKILL` if the leader has not exited within `grace`. Completes once the
 * leader exited or the `SIGKILL` was sent.
 */
export const terminateGroup = Effect.fn('process.terminateGroup')(function* (
  group: ProcessGroup,
  grace: Duration.Input,
) {
  yield* group.signal('SIGTERM');
  // Only "has the leader gone?" matters here; a spawn failure is the caller's to observe through `group.exit`.
  const settled = yield* Effect.timeoutOption(Effect.ignore(group.exit), grace);
  if (Option.isNone(settled)) yield* group.signal('SIGKILL');
});

const startGroupLeader = Effect.fnUntraced(function* (spec: ProcessGroupSpec) {
  const exited = yield* Deferred.make<ProcessExit, ProcessSpawnFailed>();
  const child = yield* Effect.try({
    try: () =>
      spawn(spec.command, [...(spec.args ?? [])], {
        cwd: spec.cwd,
        env: spec.env,
        shell: spec.shell ?? false,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    catch: (cause) => spawnFailed(spec.command, cause),
  });
  child.stdout?.on('data', (chunk: Buffer) => spec.onOutput(chunk, 'stdout'));
  child.stderr?.on('data', (chunk: Buffer) => spec.onOutput(chunk, 'stderr'));
  // The first of `error` and `close` settles the exit; a later one is ignored.
  child.once('error', (cause) =>
    Deferred.doneUnsafe(exited, Exit.fail(spawnFailed(spec.command, cause))),
  );
  child.once('close', (exitCode, signal) =>
    Deferred.doneUnsafe(exited, Exit.succeed({ exitCode, signal })),
  );
  return { child, exited };
});

function spawnFailed(command: string, cause: unknown) {
  const code = (cause as { readonly code?: unknown } | null)?.code;
  return new ProcessSpawnFailed({
    command,
    systemErrorCode: typeof code === 'string' && code.length > 0 ? code : null,
    cause,
  });
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.pid === undefined) return;
  try {
    // Windows has no process groups; signalling the leader is all there is.
    process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal);
  } catch {
    // ESRCH: the group already exited between the check and the signal.
  }
}
