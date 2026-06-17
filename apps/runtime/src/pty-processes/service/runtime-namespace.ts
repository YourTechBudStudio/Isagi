import { createHash } from 'node:crypto';
import { delimiter, dirname, resolve } from 'node:path';
import process from 'node:process';

import type { AgentHarness } from '@isagi/contracts';

export function terminalShellCommand() {
  return process.env.SHELL || 'bash';
}

export function commandForHarness(harness: AgentHarness) {
  return harness;
}

export function titleForHarness(harness: AgentHarness | null) {
  switch (harness) {
    case 'opencode':
      return 'OpenCode';
    case 'claude':
      return 'Claude';
    case 'codex':
      return 'Codex';
    case 'pi':
    default:
      return 'Pi';
  }
}

export function launchEnv() {
  return {
    ...process.env,
    PATH: pathWithRuntimeNodeBin(process.env.PATH),
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
