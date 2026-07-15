import { realpath } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export { developmentPaths, runtimeLogPrefix, webReadinessPrefix } from './dev-protocol.mjs';

export function isLoopbackUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
  const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  return hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.');
}

export function exitCodeForResult({ code, signal }) {
  if (typeof code === 'number' && code !== 0) return code;
  if (signal) return signalExitCode(signal);
  return code === 0 ? 0 : 1;
}

export function signalExitCode(signal) {
  const number = osConstants.signals[signal];
  return typeof number === 'number' ? 128 + number : 1;
}

export async function resolveRepositoryRoot(supervisorModuleUrl) {
  const root = await realpath(resolve(fileURLToPath(new URL('.', supervisorModuleUrl)), '../..'));
  return root;
}
