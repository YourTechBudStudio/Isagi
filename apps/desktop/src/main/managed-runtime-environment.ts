import { privateRuntimeEnvironmentKeys } from '../../../../scripts/dev-supervisor/dev-protocol.mjs';

/**
 * The environment a managed runtime is spawned with.
 *
 * Only the managed target reaches this module. A runtime attached through
 * `ISAGI_RUNTIME_URL` is not spawned by the desktop at all, so it inherits
 * nothing from here and is declared nothing by it.
 */

/**
 * Drops the values the desktop owns from the inherited environment, so an
 * operator's stray value cannot reach a runtime the desktop did not intend it
 * for. Every key removed here is one the assembler below sets deliberately.
 */
export function sanitizeManagedRuntimeEnvironment(environment: NodeJS.ProcessEnv) {
  const sanitized = { ...environment };
  for (const key of privateRuntimeEnvironmentKeys) delete sanitized[key];
  delete sanitized.VITE_ISAGI_RUNTIME_URL;
  delete sanitized.ISAGI_ALLOWED_ORIGINS;
  delete sanitized.ISAGI_DATA_DIR;
  return sanitized;
}

/**
 * The single assembler for a managed runtime's spawn environment: sanitize the
 * inherited values first, then declare the desktop's own. Keeping the order in
 * one pure function is what makes "an inherited value cannot shadow a
 * declaration" a testable property rather than a reading of the call site.
 */
export function managedRuntimeSpawnEnvironment(input: {
  readonly inherited: NodeJS.ProcessEnv;
  readonly allowedOrigins: string;
  readonly dataDirectory: string | undefined;
}): NodeJS.ProcessEnv {
  return {
    ...sanitizeManagedRuntimeEnvironment(input.inherited),
    ELECTRON_RUN_AS_NODE: '1',
    HOST: '127.0.0.1',
    PORT: '0',
    ISAGI_ALLOWED_ORIGINS: input.allowedOrigins,
    ...(input.dataDirectory ? { ISAGI_DATA_DIR: input.dataDirectory } : {}),
  };
}
