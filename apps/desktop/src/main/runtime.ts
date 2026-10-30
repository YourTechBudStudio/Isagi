// The Electron implementation of `RuntimeProcessConfig`: which runtime to start (the staged one, or the external one
// named by ISAGI_RUNTIME_URL), how to spawn and health-check it, and where its output goes.
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Duration, Effect, Layer } from 'effect';
import { HttpClient } from 'effect/http';
import { app } from 'electron';

import {
  developmentEnvironmentKeys,
  developmentPaths,
} from '../../../../scripts/dev-supervisor/dev-protocol.mjs';
import { waitForRuntimeHealth } from './boot.js';
import { resolveDevelopmentRoot } from './development.js';
import {
  managedRuntimeServeArguments,
  managedRuntimeSpawnEnvironment,
} from './managed-runtime-environment.js';
import { managedRuntimeAllowedOrigins } from './runtime-origin.js';
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

/**
 * Reads the environment and Electron's `app` when the layer builds (after `whenReady`). Requires the `HttpClient` the
 * health checks use; the desktop composition provides `RuntimeHttpClient`.
 */
export const RuntimeProcessConfigElectron: Layer.Layer<
  RuntimeProcessConfig,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  RuntimeProcessConfig,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const externalUrl = process.env.ISAGI_RUNTIME_URL;
    return RuntimeProcessConfig.of({
      target: externalUrl
        ? { ownership: 'external', url: externalUrl }
        : { ownership: 'managed', prepare: prepareManagedRuntime },
      adapter: nodeRuntimeProcessAdapter,
      checkHealth: (url) =>
        waitForRuntimeHealth(url).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
      log: createRuntimeLogSink(),
      readinessTimeout: Duration.seconds(15),
      stopGrace: Duration.seconds(3),
    });
  }),
);

const prepareManagedRuntime = Effect.gen(function* () {
  const configuredDataDirectory = process.env.ISAGI_DATA_DIR;
  const allowedOrigins = app.isPackaged
    ? managedRuntimeAllowedOrigins({ mode: 'packaged' })
    : managedRuntimeAllowedOrigins({
        mode: 'development',
        webOrigin: yield* requiredDevelopmentWebOrigin,
        configuredAllowedOrigins: process.env.ISAGI_ALLOWED_ORIGINS,
      });
  const locations = app.isPackaged
    ? {
        stageRoot: resolve(process.resourcesPath, 'runtime'),
        dataDirectory: configuredDataDirectory,
      }
    : developmentLocations(resolveDevelopmentRoot(repositoryRoot));
  const { stageRoot, dataDirectory } = locations;
  if (!app.isPackaged) {
    yield* Effect.logInfo(`runtime stage ${stageRoot}`);
    yield* Effect.logInfo(`runtime data ${dataDirectory}`);
    if (configuredDataDirectory && configuredDataDirectory !== dataDirectory) {
      yield* Effect.logInfo(
        `ignoring ISAGI_DATA_DIR=${configuredDataDirectory}; managed development uses ${dataDirectory}`,
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
    args: [stage.entrypoint, ...managedRuntimeServeArguments({ allowedOrigins, dataDirectory })],
    cwd: stage.root,
    processGroupOwnership:
      !app.isPackaged && process.env[developmentEnvironmentKeys.processOwner] === '1'
        ? 'external'
        : 'self',
    env: managedRuntimeSpawnEnvironment({ inherited: process.env }),
  };
  return specification;
});

function developmentLocations(developmentRoot: string) {
  const paths = developmentPaths(developmentRoot);
  return {
    stageRoot: paths.runtimeStage,
    dataDirectory: paths.dataRoot,
  };
}

const requiredDevelopmentWebOrigin = Effect.suspend(() => {
  const configured = process.env[developmentEnvironmentKeys.webUrl];
  if (!configured) {
    return Effect.fail(
      new RuntimeLifecycleFailure({
        reason: 'launch_configuration_invalid',
        diagnostic: {
          message: 'Managed desktop development requires ISAGI_WEB_URL with an exact web origin.',
        },
      }),
    );
  }
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
