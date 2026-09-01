import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Effect } from 'effect';
import { app } from 'electron';

import {
  developmentEnvironmentKeys,
  developmentPaths,
} from '../../../../scripts/dev-supervisor/dev-protocol.mjs';
import { waitForRuntimeHealth } from './boot.js';
import { resolveDevelopmentRoot } from './development.js';
import { managedRuntimeSpawnEnvironment } from './managed-runtime-environment.js';
import { managedRuntimeAllowedOrigins } from './runtime-origin.js';
import {
  createRuntimeLogSink,
  nodeRuntimeProcessAdapter,
  RuntimeLifecycle,
  RuntimeLifecycleFailure,
  type RuntimeSpawnSpecification,
  validateRuntimeStage,
} from './runtime-process/index.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(currentDirectory, '../..');
const repositoryRoot = resolve(desktopRoot, '../..');

export function createRuntimeLifecycle() {
  const externalUrl = process.env.ISAGI_RUNTIME_URL;
  const target = externalUrl
    ? ({ ownership: 'external', url: externalUrl } as const)
    : ({ ownership: 'managed', prepare: prepareManagedRuntime } as const);

  return new RuntimeLifecycle(target, {
    processAdapter: nodeRuntimeProcessAdapter,
    checkHealth: (url) => Effect.runPromise(waitForRuntimeHealth(url)),
    log: createRuntimeLogSink(),
  });
}

function prepareManagedRuntime(): RuntimeSpawnSpecification {
  const configuredDataDirectory = process.env.ISAGI_DATA_DIR;
  const allowedOrigins = app.isPackaged
    ? managedRuntimeAllowedOrigins({ mode: 'packaged' })
    : managedRuntimeAllowedOrigins({
        mode: 'development',
        webOrigin: requiredDevelopmentWebOrigin(),
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
    console.info(`[desktop] runtime stage ${stageRoot}`);
    console.info(`[desktop] runtime data ${dataDirectory}`);
    if (configuredDataDirectory && configuredDataDirectory !== dataDirectory) {
      console.info(
        `[desktop] ignoring ISAGI_DATA_DIR=${configuredDataDirectory}; managed development uses ${dataDirectory}`,
      );
    }
  }
  let stage;
  try {
    stage = validateRuntimeStage(stageRoot);
  } catch (error) {
    throw new RuntimeLifecycleFailure({
      reason: 'stage_invalid',
      diagnostic: { message: errorMessage(error) },
    });
  }

  return {
    command: process.execPath,
    args: [stage.entrypoint],
    cwd: stage.root,
    processGroupOwnership:
      !app.isPackaged && process.env[developmentEnvironmentKeys.processOwner] === '1'
        ? 'external'
        : 'self',
    env: managedRuntimeSpawnEnvironment({
      inherited: process.env,
      allowedOrigins,
      dataDirectory,
    }),
  };
}

function developmentLocations(developmentRoot: string) {
  const paths = developmentPaths(developmentRoot);
  return {
    stageRoot: paths.runtimeStage,
    dataDirectory: paths.dataRoot,
  };
}

function requiredDevelopmentWebOrigin() {
  const configured = process.env[developmentEnvironmentKeys.webUrl];
  if (!configured) {
    throw new RuntimeLifecycleFailure({
      reason: 'launch_configuration_invalid',
      diagnostic: {
        message: 'Managed desktop development requires ISAGI_WEB_URL with an exact web origin.',
      },
    });
  }
  try {
    const url = new URL(configured);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('unsupported or credential-bearing URL');
    }
    return url.origin;
  } catch {
    throw new RuntimeLifecycleFailure({
      reason: 'launch_configuration_invalid',
      diagnostic: { message: 'ISAGI_WEB_URL must be an absolute HTTP(S) URL without credentials.' },
    });
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
