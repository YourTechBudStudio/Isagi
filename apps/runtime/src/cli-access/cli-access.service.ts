import { delimiter, dirname } from 'node:path';
import process from 'node:process';

import { Context, Data, Effect, Layer, Option, Ref } from 'effect';

import { DataDirectory, type DataDirectoryService } from '../persistence/data-directory.service.js';
import { cliEntryPath, runtimePackageVersion } from '../runtime-assets.js';
import { cliShimPath, renderCliShim, writeCliShim } from './shim.js';

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
 * What makes the `isagi` CLI usable from every process the runtime launches: the shim's directory
 * first on `PATH`, and the runtime's URL once it is listening.
 *
 * The PTY layer asks for these per launch and knows nothing else about the CLI.
 */
export interface CliAccessService {
  /** Called once, right after the server is listening. */
  readonly publishRuntimeUrl: (url: string) => Effect.Effect<void>;
  /** The variables every runtime-launched PTY gets on top of its sanitized user environment. */
  readonly launchEnvironment: (
    basePath: string | undefined,
  ) => Effect.Effect<Readonly<Record<string, string>>>;
}

export const CliAccess = Context.GenericTag<CliAccessService>('isagi/CliAccess');

/**
 * Writes the shim for this runtime version and returns the service over it.
 *
 * Exported for tests, which point it at a temporary tools directory; the runtime uses `CliAccessLive`.
 */
export function makeCliAccess(input: {
  readonly shimPath: string;
  readonly execPath: string;
  readonly entryPath: string;
}): Effect.Effect<CliAccessService, CliShimError> {
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
    return {
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
    } satisfies CliAccessService;
  });
}

export const CliAccessLive: Layer.Layer<CliAccessService, CliShimError, DataDirectoryService> =
  Layer.effect(
    CliAccess,
    Effect.flatMap(DataDirectory, (directory) =>
      makeCliAccess({
        shimPath: cliShimPath(directory.paths.toolsPath, runtimePackageVersion),
        execPath: process.execPath,
        entryPath: cliEntryPath,
      }),
    ),
  );

/** For tests that launch PTYs: publishes nothing and adds nothing to a launch's environment. */
export const noCliAccess: CliAccessService = {
  publishRuntimeUrl: () => Effect.void,
  launchEnvironment: () => Effect.succeed({}),
};

export const CliAccessNone: Layer.Layer<CliAccessService> = Layer.succeed(CliAccess, noCliAccess);
