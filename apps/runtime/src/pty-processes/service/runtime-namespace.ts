import { createHash } from 'node:crypto';
import { delimiter, dirname, resolve } from 'node:path';
import process from 'node:process';

export function terminalShellCommand() {
  return process.env.SHELL || 'bash';
}

export function launchEnv() {
  return {
    ...userShellBaseEnv(),
    PATH: pathWithRuntimeNodeBin(process.env.PATH),
  } satisfies NodeJS.ProcessEnv;
}

export function userShellBaseEnv() {
  return {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  } satisfies NodeJS.ProcessEnv;
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
