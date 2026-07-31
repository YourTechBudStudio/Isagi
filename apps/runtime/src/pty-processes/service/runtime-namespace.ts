import { createHash } from 'node:crypto';
import { delimiter, dirname, resolve } from 'node:path';
import process from 'node:process';

export function terminalShellCommand() {
  return process.env.SHELL || 'bash';
}

export function launchEnv(environment: NodeJS.ProcessEnv = process.env) {
  const sanitized = userShellBaseEnv(environment);
  return {
    ...sanitized,
    PATH: pathWithRuntimeNodeBin(sanitized.PATH),
  } satisfies NodeJS.ProcessEnv;
}

export function userShellBaseEnv(environment: NodeJS.ProcessEnv = process.env) {
  const sanitized: NodeJS.ProcessEnv = {
    ...environment,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  };
  for (const key of Object.keys(sanitized)) {
    if (key.startsWith('ISAGI_')) delete sanitized[key];
  }
  delete sanitized.ELECTRON_RUN_AS_NODE;
  delete sanitized.HOST;
  delete sanitized.PORT;
  delete sanitized.VITE_ISAGI_RUNTIME_URL;
  return sanitized;
}

function pathWithRuntimeNodeBin(path: string | undefined) {
  const nodeBin = dirname(process.execPath);
  if (!path) return nodeBin;
  const entries = path.split(delimiter);
  return entries.includes(nodeBin) ? path : [nodeBin, ...entries].join(delimiter);
}

export function runtimeNamespace(root: string) {
  return createHash('sha256').update(resolve(root)).digest('hex').slice(0, 8);
}

export function spawnFailureMessage(command: string, cwd: string, error: unknown) {
  const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : error;
  const reason = cause instanceof Error && cause.message ? cause.message : String(cause);
  return `\r\nFailed to start ${command} in ${cwd}: ${reason}\r\n`;
}
