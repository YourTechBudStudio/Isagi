import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Effect } from 'effect';
import { app } from 'electron';

import { waitForRuntimeHealth } from './boot.js';
import {
  createRuntimeLogSink,
  nodeRuntimeProcessAdapter,
  RuntimeLifecycle,
  RuntimeLifecycleFailure,
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

function prepareManagedRuntime() {
  const webOrigin = app.isPackaged ? undefined : requiredDevelopmentWebOrigin();
  const stageRoot = app.isPackaged
    ? resolve(process.resourcesPath, 'runtime')
    : resolve(desktopRoot, '.generated/runtime');
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
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HOST: '127.0.0.1',
      PORT: '0',
      ...(webOrigin ? { ISAGI_ALLOWED_ORIGINS: mergeAllowedOrigins(webOrigin) } : {}),
      ...(!app.isPackaged && !process.env.ISAGI_DATA_DIR
        ? { ISAGI_DATA_DIR: resolve(repositoryRoot, 'data/.isagi') }
        : {}),
    },
  };
}

function requiredDevelopmentWebOrigin() {
  const configured = process.env.ISAGI_WEB_URL;
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

function mergeAllowedOrigins(webOrigin: string) {
  const configured = process.env.ISAGI_ALLOWED_ORIGINS?.split(',') ?? [];
  return [
    ...new Set([webOrigin, ...configured.map((origin) => origin.trim()).filter(Boolean)]),
  ].join(',');
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
