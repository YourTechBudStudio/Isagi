import { privateRuntimeEnvironmentKeys } from '../../../../scripts/dev-supervisor/dev-protocol.mjs';

export function sanitizeManagedRuntimeEnvironment(environment: NodeJS.ProcessEnv) {
  const sanitized = { ...environment };
  for (const key of privateRuntimeEnvironmentKeys) delete sanitized[key];
  delete sanitized.VITE_ISAGI_RUNTIME_URL;
  delete sanitized.ISAGI_ALLOWED_ORIGINS;
  delete sanitized.ISAGI_DATA_DIR;
  return sanitized;
}
