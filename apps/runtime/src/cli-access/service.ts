import { delimiter, dirname } from 'node:path';
import process from 'node:process';

import { Context, Data, Effect, Layer, Option, Ref } from 'effect';

import { requireAssetFile, runtimePackageVersion } from '../platform/assets/index.js';
import { DataDirectory } from '../platform/persistence/index.js';
import { cliShimPath, renderCliShim, writeCliShim } from './shim.js';

/**
 * The bundled `isagi` CLI, which the runtime's shim runs. Asserted at load, like every other asset:
 * a runtime built without it is a build defect, and terminals would silently lack the CLI.
 */
const cliEntryPath = requireAssetFile('cli/isagi.mjs');

/** The shim could not be written, so the runtime refuses to start rather than run without `isagi`. */
export class CliShimError extends Data.TaggedError('CliShimError')<{
  readonly path: string;
  readonly cause: unknown;
}> {
  override get message() {
    const cause = this.cause instanceof Error ? this.cause.message : String(this.cause);
    return `Could not write the isagi CLI shim at ${this.path}: ${cause}`;
  }
}

/**
 * Writes the shim for this runtime version and returns the service over it.
 *
 * Exported for tests, which point it at a temporary tools directory; the runtime uses `CliAccess.layer`.
 */
export function makeCliAccess(input: {
  readonly shimPath: string;
  readonly execPath: string;
  readonly entryPath: string;
}): Effect.Effect<CliAccess['Service'], CliShimError> {
  return Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () =>
        writeCliShim(
          input.shimPath,
          renderCliShim({ execPath: input.execPath, entryPath: input.entryPath }),
        ),
      catch: (cause) => new CliShimError({ path: input.shimPath, cause }),
    });
    const binDirectory = dirname(input.shimPath);
    const runtimeUrl = yield* Ref.make(Option.none<string>());
    return CliAccess.of({
      publishRuntimeUrl: (url) => Ref.set(runtimeUrl, Option.some(url)),
      launchEnvironment: (basePath) =>
        Effect.map(Ref.get(runtimeUrl), (url) => ({
          PATH: basePath ? `${binDirectory}${delimiter}${basePath}` : binDirectory,
          // Before `listen` there is no URL to give; the CLI then reports `runtime_unconfigured`.
          ...Option.match(url, {
            onNone: () => ({}),
            onSome: (value) => ({ ISAGI_RUNTIME_URL: value }),
          }),
        })),
    });
  });
}

const make = Effect.flatMap(DataDirectory, (directory) =>
  makeCliAccess({
    shimPath: cliShimPath(directory.paths.toolsPath, runtimePackageVersion),
    execPath: process.execPath,
    entryPath: cliEntryPath,
  }),
);

/**
 * What makes the `isagi` CLI usable from every process the runtime launches: the shim's directory
 * first on `PATH`, and the runtime's URL once it is listening.
 *
 * The PTY layer asks for these per launch and knows nothing else about the CLI.
 */
export class CliAccess extends Context.Service<
  CliAccess,
  {
    /** Called once, right after the server is listening. */
    readonly publishRuntimeUrl: (url: string) => Effect.Effect<void>;
    /** The variables every runtime-launched PTY gets on top of its sanitized user environment. */
    readonly launchEnvironment: (
      basePath: string | undefined,
    ) => Effect.Effect<Readonly<Record<string, string>>>;
  }
>()('isagi/runtime/cli-access/CliAccess') {
  static readonly layer = Layer.effect(CliAccess, make);
}

/** For tests that launch PTYs: publishes nothing and adds nothing to a launch's environment. */
export const noCliAccess: CliAccess['Service'] = {
  publishRuntimeUrl: () => Effect.void,
  launchEnvironment: () => Effect.succeed({}),
};

export const CliAccessNone: Layer.Layer<CliAccess> = Layer.succeed(CliAccess, noCliAccess);
