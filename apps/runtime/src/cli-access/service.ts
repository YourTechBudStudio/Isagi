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

/** Writes the shim for this runtime version under the data root's tools directory, then serves the launch environment. */
const make = Effect.gen(function* () {
  const directory = yield* DataDirectory;
  const shimPath = cliShimPath(directory.paths.toolsPath, runtimePackageVersion);
  yield* Effect.tryPromise({
    try: () =>
      writeCliShim(
        shimPath,
        renderCliShim({ execPath: process.execPath, entryPath: cliEntryPath }),
      ),
    catch: (cause) => new CliShimError({ path: shimPath, cause }),
  });
  const binDirectory = dirname(shimPath);
  const runtimeUrl = yield* Ref.make(Option.none<string>());
  return CliAccess.of({
    publishRuntimeUrl: Effect.fn('CliAccess.publishRuntimeUrl')(function* (url: string) {
      yield* Ref.set(runtimeUrl, Option.some(url));
    }),
    launchEnvironment: Effect.fn('CliAccess.launchEnvironment')(function* (
      basePath: string | undefined,
    ) {
      const url = yield* Ref.get(runtimeUrl);
      return {
        PATH: basePath ? `${binDirectory}${delimiter}${basePath}` : binDirectory,
        // Before `listen` there is no URL to give; the CLI then reports `runtime_unconfigured`.
        ...Option.match(url, {
          onNone: () => ({}),
          onSome: (value) => ({ ISAGI_RUNTIME_URL: value }),
        }),
      };
    }),
  });
});

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
