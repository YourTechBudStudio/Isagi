// Lifecycle-leak probes for tests that own fibers, timers, sockets, or OS processes. Each one turns "nothing outlived
// the scope" into an assertion. They wait with real timers (never `Effect.sleep`), so they behave the same under
// `runScoped` and `runWithTestClock`.
import { execFile } from 'node:child_process';

import { Effect, Layer, Metric } from 'effect';

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

/** Kinds of Node resources (timers, sockets, child processes, watchers) that keep the event loop alive. */
const activeHandles = (): ReadonlyArray<string> =>
  process.getActiveResourcesInfo().filter((name) => name !== 'TTYWrap');

const countBy = (names: ReadonlyArray<string>) => {
  const counts: Record<string, number> = {};
  for (const name of names) counts[name] = (counts[name] ?? 0) + 1;
  return counts;
};

/**
 * Runs `body` and dies with `leaked handles: {...}` if it leaves more Node handles of any kind than existed before.
 * Handles close asynchronously (a child process after `close`, a socket after FIN), so it polls 20 × 10 ms first.
 */
export const expectNoNewHandles = <A, E, R>(body: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const before = countBy(activeHandles());
    const result = yield* body;
    let leaked: Array<[string, number]> = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      yield* waitMs(10);
      const after = countBy(activeHandles());
      leaked = Object.entries(after).filter(([kind, count]) => count > (before[kind] ?? 0));
      if (leaked.length === 0) return result;
    }
    return yield* Effect.die(
      new Error(`leaked handles: ${JSON.stringify(Object.fromEntries(leaked))}`),
    );
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

// `pgrep -f` takes an extended regular expression; the marker is matched literally.
const literalPattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Pids whose full command line contains `marker` (pgrep never lists itself). */
const pidsMatching = (marker: string) =>
  run('pgrep', ['-f', literalPattern(marker)]).pipe(
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

const describeProcesses = (pids: ReadonlyArray<string>) =>
  run('ps', ['-o', 'pid=,args=', '-p', pids.join(',')]).pipe(
    Effect.map(({ stdout }) => stdout.trim() || `pids ${pids.join(', ')}`),
    Effect.orElseSucceed(() => `pids ${pids.join(', ')}`),
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
        const survivors = yield* describeProcesses(pids);
        return yield* Effect.die(
          new Error(
            `processes matching ${JSON.stringify(marker)} still running after ${withinMs} ms:\n${survivors}`,
          ),
        );
      }
      yield* waitMs(50);
    }
  });
