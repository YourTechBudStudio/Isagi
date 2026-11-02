import { homedir } from 'node:os';
import process from 'node:process';

import { Effect } from 'effect';

import type { CliIo } from '../context.js';
import { causeText, CliFailure } from '../errors.js';
import type { RuntimeEntry, RuntimeEntryModule } from './launch.js';
import { resolveServeLaunch, type ServeFlags } from './settings.js';

/**
 * The production `serve`: resolve and validate the flag and environment tiers, load the runtime
 * module, and hand it the launch. This is the only place the CLI imports the runtime, so every
 * other command (help included) loads no runtime code and no native module.
 *
 * After the hand-off nothing is printed: the runtime's `ISAGI_RUNTIME_READY` line and its logs are
 * the startup output, and its own `runMain` owns signals and the exit status from here.
 */
export function serveRuntimeCommand(
  io: CliIo,
  runtimeEntry: RuntimeEntry | undefined,
): (flags: ServeFlags) => Effect.Effect<void, CliFailure> {
  return Effect.fn('cli.serve')(function* (flags: ServeFlags) {
    const resolved = resolveServeLaunch(
      flags,
      { env: io.env, cwd: io.cwd, home: homedir() },
      { webRoot: runtimeEntry?.defaultWebRoot },
    );
    if (!resolved.ok) return yield* resolved.failure;
    if (runtimeEntry === undefined) {
      return yield* Effect.die(new Error('runCli was called without a runtime entry.'));
    }
    const launcherToken = takeLauncherToken(io);
    const module = yield* Effect.tryPromise({
      try: () => runtimeEntry.load(),
      catch: (cause) => loadFailed(runtimeEntry, causeText(cause)),
    });
    if (!isRuntimeEntryModule(module)) {
      return yield* loadFailed(runtimeEntry, 'The runtime module does not export serveRuntime.');
    }
    yield* Effect.sync(() =>
      module.serveRuntime({
        ...resolved.settings,
        cliEntryPath: runtimeEntry.cliEntryPath,
        launcherToken,
      }),
    );
  });
}

/**
 * The desktop's launcher token from `ISAGI_LAUNCHER_TOKEN`: trimmed, and unset or empty means none. The variable is
 * always removed before the runtime loads, because worktree setup hooks run with the runtime's raw `process.env`.
 */
function takeLauncherToken(io: CliIo): string | undefined {
  const value = io.env[launcherTokenVariable]?.trim();
  io.unsetEnv(launcherTokenVariable);
  return value === undefined || value === '' ? undefined : value;
}

const launcherTokenVariable = 'ISAGI_LAUNCHER_TOKEN';

function isRuntimeEntryModule(value: unknown): value is RuntimeEntryModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'serveRuntime' in value &&
    typeof value.serveRuntime === 'function'
  );
}

/** The runtime module could not be loaded: most often native modules built for another Node. */
function loadFailed(entry: RuntimeEntry, cause: string): CliFailure {
  return CliFailure.of('runtime_load_failed', `Could not load the Isagi runtime: ${cause}`, {
    context: {
      entryPath: entry.cliEntryPath,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cause,
    },
  });
}
