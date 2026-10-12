// Runtime test probes: Effect log capture plus leak checks for fibers, Node handles and OS processes. Each leak probe
// turns "nothing outlived the scope" into an assertion. They wait with real timers (never `Effect.sleep`), so they
// behave the same under the live clock and under `TestClock`.
import { execFile } from 'node:child_process';

import { Cause, Effect, Formatter, Layer, Logger, Metric, References, type LogLevel } from 'effect';

export interface CapturedLog {
  readonly level: LogLevel.LogLevel;
  /** The logged message parts joined by a space; non-string parts are rendered with Effect's formatter. */
  readonly message: string;
  /** Log annotations (`Effect.annotateLogs`) active when the line was logged. */
  readonly annotations: Readonly<Record<string, unknown>>;
  /** `Cause.pretty` of the cause attached to the log call, or `undefined` when there was none. */
  readonly cause: string | undefined;
}

/**
 * Records every log line into `lines`. Providing `layer` replaces the current loggers, so nothing is printed. Lines
 * below the minimum log level (default `Info`) never reach a logger; provide `References.MinimumLogLevel` for `Debug`.
 */
export const makeLogCapture = () => {
  const lines: CapturedLog[] = [];
  const logger = Logger.make(({ logLevel, message, cause, fiber }) => {
    lines.push({
      level: logLevel,
      message: (Array.isArray(message) ? message : [message])
        .map((part: unknown) => (typeof part === 'string' ? part : Formatter.format(part)))
        .join(' '),
      annotations: { ...fiber.getRef(References.CurrentLogAnnotations) },
      cause: cause.reasons.length > 0 ? Cause.pretty(cause) : undefined,
    });
  });
  return { lines, layer: Logger.layer([logger]) };
};

/**
 * Counts child fibers started and ended under the provided context. Provide `layer` at the root of the layer or
 * effect under test; after its scope closes, `counts.active` is the number of fibers that outlived it.
 */
export const makeFiberProbe = () => {
  const counts = { started: 0, active: 0 };
  const layer = Layer.succeed(Metric.FiberRuntimeMetrics)({
    recordFiberStart: () => {
      counts.started++;
      counts.active++;
    },
    recordFiberEnd: () => {
      counts.active--;
    },
  });
  return { counts, layer };
};

const waitMs = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

/** Counts of the Node resource kinds (timers, sockets, child processes, watchers) keeping the event loop alive. */
export const activeHandleCounts = (): Readonly<Record<string, number>> => {
  const counts: Record<string, number> = {};
  for (const name of process.getActiveResourcesInfo())
    if (name !== 'TTYWrap') counts[name] = (counts[name] ?? 0) + 1;
  return counts;
};

/**
 * Dies with `leaked handles: {...}` unless every handle kind is back to (or below) its `baseline` count within
 * `withinMs` (default 200). Handles close asynchronously (a child process after `close`, a socket after FIN).
 */
export const expectHandlesBackTo = (
  baseline: Readonly<Record<string, number>>,
  options: { readonly withinMs?: number } = {},
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const deadline = Date.now() + (options.withinMs ?? 200);
    for (;;) {
      yield* waitMs(10);
      const leaked = Object.entries(activeHandleCounts()).filter(
        ([kind, count]) => count > (baseline[kind] ?? 0),
      );
      if (leaked.length === 0) return;
      if (Date.now() >= deadline)
        return yield* Effect.die(
          new Error(`leaked handles: ${JSON.stringify(Object.fromEntries(leaked))}`),
        );
    }
  });

/** Runs `body` and dies if it leaves more Node handles of any kind than existed before it. */
export const expectNoNewHandles = <A, E, R>(body: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const before = activeHandleCounts();
    return Effect.tap(body, () => expectHandlesBackTo(before));
  });

const run = (file: string, args: ReadonlyArray<string>) =>
  Effect.callback<{ readonly exitCode: number; readonly stdout: string }, Error>((resume) => {
    const child = execFile(file, args, (error, stdout) => {
      if (error === null) resume(Effect.succeed({ exitCode: 0, stdout }));
      else if (typeof error.code === 'number')
        resume(Effect.succeed({ exitCode: error.code, stdout }));
      else resume(Effect.fail(error));
    });
    return Effect.sync(() => child.kill());
  });

/** Pids whose full command line contains `marker` literally (`pgrep -f` takes a regex; pgrep never lists itself). */
export const pidsMatching = (marker: string): Effect.Effect<ReadonlyArray<string>> =>
  run('pgrep', ['-f', marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')]).pipe(
    Effect.flatMap(({ exitCode, stdout }) =>
      exitCode === 0
        ? Effect.succeed(stdout.split('\n').filter((line) => line.trim() !== ''))
        : exitCode === 1
          ? Effect.succeed([])
          : Effect.fail(new Error(`pgrep exited with ${exitCode}`)),
    ),
    // A probe that cannot look must not read as "no process left".
    Effect.orDie,
  );

/**
 * Succeeds once no OS process has `marker` in its command line, polling every 50 ms; dies after `withinMs` (default
 * 2000) with the survivors' pids and command lines. node-pty children and spawned process groups are not Node
 * handles, so a test puts a unique marker in the command it launches and asserts with this after teardown.
 */
export const expectNoProcessMatching = (
  marker: string,
  options: { readonly withinMs?: number } = {},
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (marker.trim() === '')
      return yield* Effect.die(new Error('expectNoProcessMatching: marker must not be empty'));
    const withinMs = options.withinMs ?? 2_000;
    const deadline = Date.now() + withinMs;
    for (;;) {
      const pids = yield* pidsMatching(marker);
      if (pids.length === 0) return;
      if (Date.now() >= deadline) {
        const survivors = yield* run('ps', ['-o', 'pid=,args=', '-p', pids.join(',')]).pipe(
          Effect.map(({ stdout }) => stdout.trim() || `pids ${pids.join(', ')}`),
          Effect.orElseSucceed(() => `pids ${pids.join(', ')}`),
        );
        return yield* Effect.die(
          new Error(
            `processes matching ${JSON.stringify(marker)} still running after ${withinMs} ms:\n${survivors}`,
          ),
        );
      }
      yield* waitMs(50);
    }
  });
