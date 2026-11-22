// The Electron implementation of `RuntimeProcessConfig`: the staged runtime to start, how to spawn and health-check
// it, and where its output goes.
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Duration, Effect, Layer, type Redacted } from 'effect';
import { HttpClient } from 'effect/http';

import {
  developmentEnvironmentKeys,
  developmentPaths,
} from '../../../../scripts/dev-supervisor/dev-protocol.mjs';
import { waitForRuntimeHealth } from './boot.js';
import type { DesktopMode } from './desktop-mode.js';
import { resolveDevelopmentRoot } from './development.js';
import {
  developmentAllowedOrigins,
  managedRuntimeServeArguments,
  managedRuntimeSpawnEnvironment,
} from './managed-runtime-environment.js';
import {
  createRuntimeLogSink,
  nodeRuntimeProcessAdapter,
  RuntimeLifecycleFailure,
  RuntimeProcessConfig,
  type RuntimeSpawnSpecification,
  validateRuntimeStage,
} from './runtime-process/index.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(currentDirectory, '../..');
const repositoryRoot = resolve(desktopRoot, '../..');

/** What `index.ts` resolved before the window existed; the runtime is launched from the same answers. */
export interface ManagedRuntimeLaunch {
  readonly mode: DesktopMode;
  /** Passed as `--data-dir`, always. */
  readonly dataDirectory: string;
}

/**
 * Reads the environment when the layer builds (after `whenReady`). Requires the `HttpClient` the health checks use;
 * the desktop composition provides `RuntimeHttpClient`.
 */
export const runtimeProcessConfigElectron = (
  launch: ManagedRuntimeLaunch,
): Layer.Layer<RuntimeProcessConfig, never, HttpClient.HttpClient> =>
  Layer.effect(
    RuntimeProcessConfig,
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      return RuntimeProcessConfig.of({
        prepare: (spawn) => prepareManagedRuntime(launch, spawn),
        adapter: nodeRuntimeProcessAdapter,
        checkHealth: (url) =>
          waitForRuntimeHealth(url).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
        log: createRuntimeLogSink(),
        readinessTimeout: Duration.seconds(15),
        stopGrace: Duration.seconds(3),
      });
    }),
  );

function prepareManagedRuntime(
  launch: ManagedRuntimeLaunch,
  spawn: { readonly launcherToken: Redacted.Redacted<string> },
) {
  return Effect.gen(function* () {
    const { mode, dataDirectory } = launch;
    const allowedOrigins =
      mode.kind === 'development'
        ? developmentAllowedOrigins({
            webOrigin: yield* developmentWebOrigin(mode.webUrl),
            configuredAllowedOrigins: process.env.ISAGI_ALLOWED_ORIGINS,
          })
        : undefined;
    const locations =
      mode.kind === 'packaged'
        ? {
            stageRoot: resolve(process.resourcesPath, 'runtime'),
            // The packaged web build (`extraResources` → `web`), which the window loads from the runtime.
            webRoot: resolve(process.resourcesPath, 'web'),
          }
        : checkoutLocations(resolveDevelopmentRoot(repositoryRoot));
    const { stageRoot, webRoot } = locations;
    if (mode.kind !== 'packaged') {
      yield* Effect.logInfo(`runtime stage ${stageRoot}`);
      yield* Effect.logInfo(`runtime data ${dataDirectory}`);
      const configured = process.env.ISAGI_DATA_DIR;
      if (configured && mode.kind === 'development') {
        yield* Effect.logInfo(
          `ignoring ISAGI_DATA_DIR=${configured}; managed development uses ${dataDirectory}`,
        );
      }
    }
    const stage = yield* Effect.try({
      try: () => validateRuntimeStage(stageRoot),
      catch: (error) =>
        new RuntimeLifecycleFailure({
          reason: 'stage_invalid',
          diagnostic: { message: errorMessage(error) },
        }),
    });

    const specification: RuntimeSpawnSpecification = {
      command: process.execPath,
      args: [
        stage.entrypoint,
        ...managedRuntimeServeArguments({ allowedOrigins, dataDirectory, webRoot }),
      ],
      cwd: stage.root,
      processGroupOwnership:
        mode.kind !== 'packaged' && process.env[developmentEnvironmentKeys.processOwner] === '1'
          ? 'external'
          : 'self',
      env: managedRuntimeSpawnEnvironment({
        inherited: process.env,
        launcherToken: spawn.launcherToken,
      }),
    };
    return specification;
  });
}

function checkoutLocations(developmentRoot: string) {
  return {
    stageRoot: developmentPaths(developmentRoot).runtimeStage,
    // Built by `pnpm --filter @isagi/web build`; served by the runtime in the unpackaged production path. Development
    // loads Vite instead, but the runtime still needs a web root to start.
    webRoot: resolve(developmentRoot, 'apps/web/dist'),
  };
}

function developmentWebOrigin(configured: string) {
  return Effect.suspend(() => {
    const url = URL.canParse(configured) ? new URL(configured) : undefined;
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return Effect.fail(
        new RuntimeLifecycleFailure({
          reason: 'launch_configuration_invalid',
          diagnostic: {
            message: 'ISAGI_WEB_URL must be an absolute HTTP(S) URL without credentials.',
          },
        }),
      );
    }
    return Effect.succeed(url.origin);
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
