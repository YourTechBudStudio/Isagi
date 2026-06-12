import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import process from 'node:process';

import type { LaunchPtySessionInput } from '../types.js';

export function commandForLaunch(input: LaunchPtySessionInput) {
  if (input.purpose === 'terminal') {
    return process.env.SHELL || 'bash';
  }
  return input.harness ?? 'pi';
}

export function titleForHarness(harness: LaunchPtySessionInput['harness']) {
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
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  } satisfies NodeJS.ProcessEnv;
}

export function runtimeNamespace(root: string) {
  return createHash('sha256').update(resolve(root)).digest('hex').slice(0, 8);
}

export function spawnFailureMessage(command: string, cwd: string, error: unknown) {
  const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : error;
  const reason = cause instanceof Error && cause.message ? cause.message : String(cause);
  return `\r\nFailed to start ${command} in ${cwd}: ${reason}\r\n`;
}
